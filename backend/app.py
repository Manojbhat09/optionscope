# app.py
from flask import Flask, request, jsonify, Response
from get_rh_options_app import fetch_and_update_orders, delete_cache
import robin_stocks.robinhood as r
from flask_cors import CORS
import pandas as pd
import numpy as np
import yfinance as yf
import json, math
from chatbot_service import chatbot_bp


DATE_FIELDS = {'Activity Date', 'Process Date', 'Settle Date'}

def _clean_val(key, value):
    """Normalise a single record value: NaN→None, dates formatted, numbers kept as numbers."""
    # NaN / None check first (before any type conversion)
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    if key in DATE_FIELDS:
        try:
            return str(pd.to_datetime(value).strftime('%Y-%m-%d'))
        except Exception:
            return str(value) if value is not None else None
    # Keep numbers as numbers (not strings) — frontend can handle them
    if isinstance(value, (np.floating, np.integer)):
        return float(value)
    return value


def clean_records(df):
    """Convert a DataFrame to clean JSON-safe records."""
    rows = df.to_dict(orient='records')
    return [{k: _clean_val(k, v) for k, v in row.items()} for row in rows]


def safe_jsonify(records):
    """Serialize a list of clean dicts as a Flask JSON Response."""
    return Response(json.dumps(records), mimetype='application/json')

app = Flask(__name__)
CORS(app)

# Register the chatbot blueprint
app.register_blueprint(chatbot_bp)

'''
 Index(['Open', 'High', 'Low', 'Close', 'Adj Close', 'Volume'], dtype='object')
'''
@app.route('/api/stock-data', methods=['POST'])
def get_stock_data():
  data = request.json
  username = data['username']
  password = data['password']
  ticker = data['ticker']
  start_date = data['startDate']
  end_date = data['endDate']
  csv_file = data.get('fileName', 'orders.csv')  # Optional file name

  # "1h"  # You can choose from '1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h', '1d', '5d', '1wk', '1mo', '3mo'
  historical_data = yf.download("AAPL", start=start_date, end=end_date, interval="1h")
  df = pd.DataFrame(historical_data)
  print(historical_data)
  df = historical_data.reset_index()
  df.rename(columns={'index': 'Date'}, inplace=True)  # Rename the column for clarity
  # Convert to DataFrame and filter by date range
  
  print(df.columns)
  filtered_orders = fetch_and_update_orders(username, password, start_date, end_date, csv_file)
  filtered_orders = pd.DataFrame(filtered_orders)
  print(start_date, end_date)
  print("fixing data ", filtered_orders)
  # Convert DataFrame to dictionary and ensure all amounts are strings
  records = filtered_orders.to_dict(orient='records')
  for record in records: #  dict_keys(['Activity Date', 'Process Date', 'Settle Date', 'Instrument', 'Description', 'Trans Code', 'Quantity', 'Price', 'Amount'])
      for key, value in record.items():
          if isinstance(value, (int, float, np.float64, np.int64)):
              record[key] = str(value)
          elif pd.isna(value):  # Handle NaN values
              record[key] = None
          elif key in ['Activity Date', 'Process Date', 'Settle Date']:  # Format date fields
              try:
                  record[key] = str(pd.to_datetime(value).strftime('%Y-%m-%d'))
              except Exception as e:
                  print(f"Error formatting date for {key}: {value} - {e}")

  print(len(records))
  return jsonify({
      'stockData': df.to_dict(orient='records'),
      'optionData': records
  })

@app.route('/api/fetch-data', methods=['POST'])
def fetch_data():
  data = request.json
  username = data.get('username')
  password = data.get('password')
  start_date = data.get('startDate')
  end_date = data.get('endDate')
  print("end date is ", end_date)
  csv_file = data.get('fileName', 'orders.csv')  # Optional file name

  try:
      filtered_orders = fetch_and_update_orders(username, password, start_date, end_date, csv_file)
      records = clean_records(pd.DataFrame(filtered_orders))
      return safe_jsonify(records)
  except Exception as e:
      return jsonify({'error': str(e)}), 500

@app.route('/api/clear-cache', methods=['POST'])
def clear_cache():
    data = request.json
    username = data.get('username')
    password = data.get('password')
    start_date = data.get('startDate')
    end_date = data.get('endDate')
    csv_file = data.get('fileName', 'orders.csv')

    # Delete cached files
    try:
        delete_cache(csv_file)
    except FileNotFoundError:
        print(f"{csv_file} not found or some error in deleting")

    # Refetch data
    try:
        filtered_orders = fetch_and_update_orders(username, password, start_date, end_date, csv_file)
        records = clean_records(pd.DataFrame(filtered_orders))
        return safe_jsonify(records)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/news', methods=['POST'])
def get_news():
    data       = request.json
    ticker     = data.get('ticker', 'SPY').upper()
    open_date  = data.get('open_date', '')    # YYYY-MM-DD
    close_date = data.get('close_date', '')   # YYYY-MM-DD

    try:
        t = yf.Ticker(ticker)
        raw_news = t.news or []
    except Exception as e:
        return jsonify({'error': str(e), 'items': []}), 200

    # yfinance returns providerPublishTime as unix timestamp
    from datetime import datetime, timedelta
    try:
        open_dt  = datetime.strptime(open_date,  '%Y-%m-%d') if open_date  else None
        close_dt = datetime.strptime(close_date, '%Y-%m-%d') if close_date else None
    except Exception:
        open_dt = close_dt = None

    items = []
    for n in raw_news:
        ts = n.get('providerPublishTime') or n.get('content', {}).get('pubDate')
        # Convert unix ts
        try:
            pub = datetime.utcfromtimestamp(int(ts)) if ts and str(ts).isdigit() else None
        except Exception:
            pub = None

        title   = n.get('title') or n.get('content', {}).get('title', '')
        url     = n.get('link')  or n.get('content', {}).get('canonicalUrl', {}).get('url', '')
        source  = n.get('publisher') or n.get('content', {}).get('provider', {}).get('displayName', '')
        pub_str = pub.strftime('%Y-%m-%d') if pub else ''

        # Bucket: near open, near close, or general context
        bucket = 'context'
        if pub and open_dt and abs((pub - open_dt).days) <= 2:
            bucket = 'entry'
        elif pub and close_dt and abs((pub - close_dt).days) <= 2:
            bucket = 'exit'

        if title:
            items.append({'title': title, 'url': url, 'source': source,
                          'date': pub_str, 'bucket': bucket})

    # Sort: entry first, then exit, then context
    order = {'entry': 0, 'exit': 1, 'context': 2}
    items.sort(key=lambda x: order.get(x['bucket'], 3))

    return jsonify({'ticker': ticker, 'items': items[:12]})


import os, time as _time

# ── stock-history cache setup ──────────────────────────────────────────────────
_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
_CACHE_DIR   = os.path.join(_BACKEND_DIR, 'stock_cache')
_BACKUP_DIR  = os.path.join(_BACKEND_DIR, 'backup')
os.makedirs(_CACHE_DIR,  exist_ok=True)
os.makedirs(_BACKUP_DIR, exist_ok=True)

# Max age before re-fetching (intraday data changes fast, daily is stable)
_CACHE_TTL = {'1m': 300, '2m': 300, '5m': 600, '15m': 1800,
              '30m': 3600, '1h': 14400, '1d': 86400}

# yfinance only keeps intraday history back N days from today
_INTERVAL_MAX_AGE_DAYS = {
    '1m': 7, '2m': 60, '5m': 60, '15m': 60, '30m': 60, '1h': 730, '1d': 36500,
}
# Coarser fallback when the requested interval is unavailable for old data
_INTERVAL_FALLBACK = {
    '1m': '5m', '2m': '5m', '5m': '15m', '15m': '1h', '30m': '1h', '1h': '1d', '1d': None,
}

def _cache_key(ticker, fetch_start, fetch_end, interval):
    return f"{ticker}_{fetch_start}_{fetch_end}_{interval}".replace('/', '-')

def _load_stock_cache(key, interval):
    path = os.path.join(_CACHE_DIR, f"{key}.json")
    if not os.path.exists(path):
        return None
    ttl = _CACHE_TTL.get(interval, 86400)
    if _time.time() - os.path.getmtime(path) > ttl:
        return None          # stale — re-fetch
    with open(path) as f:
        return json.load(f)

def _save_stock_cache(key, payload, interval):
    # Primary cache (overwritten each fetch)
    cache_path = os.path.join(_CACHE_DIR, f"{key}.json")
    with open(cache_path, 'w') as f:
        json.dump(payload, f)
    # Timestamped backup (never overwritten)
    from datetime import datetime as _dt
    ts = _dt.now().strftime('%Y%m%d_%H%M%S')
    backup_path = os.path.join(_BACKUP_DIR, f"{key}_{ts}.json")
    with open(backup_path, 'w') as f:
        json.dump(payload, f)


def _df_to_records(df):
    records = []
    for _, row in df.iterrows():
        rec = {}
        for col in df.columns:
            val = row[col]
            try:
                if pd.isna(val):
                    rec[col] = None; continue
            except (TypeError, ValueError):
                pass
            if hasattr(val, 'isoformat'):
                rec[col] = val.isoformat()
            elif isinstance(val, (np.floating, np.integer)):
                rec[col] = float(val)
            else:
                rec[col] = val
        records.append(rec)
    return records


# ── provider API keys (loaded from .env or environment) ───────────────────────
import dotenv as _dotenv
_dotenv.load_dotenv(os.path.join(_BACKEND_DIR, '.env'))
_ALPACA_KEY    = os.environ.get('ALPACA_API_KEY', '')
_ALPACA_SECRET = os.environ.get('ALPACA_SECRET_KEY', '')
_POLYGON_KEY   = os.environ.get('POLYGON_API_KEY', '')


# ── Alpaca provider (1h back to 2016 via IEX, free) ──────────────────────────
_ALPACA_INTERVAL_MAP = {
    '1m': ('1', 'Minute'), '5m': ('5', 'Minute'), '15m': ('15', 'Minute'),
    '30m': ('30', 'Minute'), '1h': ('1', 'Hour'), '1d': ('1', 'Day'),
}

def _fetch_alpaca(ticker, fetch_start, fetch_end, interval, key=None, secret=None):
    ak = key    or _ALPACA_KEY
    as_ = secret or _ALPACA_SECRET
    if not ak or not as_:
        return None
    iv_params = _ALPACA_INTERVAL_MAP.get(interval)
    if iv_params is None:
        return None
    try:
        from alpaca.data import StockHistoricalDataClient
        from alpaca.data.requests import StockBarsRequest
        from alpaca.data.timeframe import TimeFrame, TimeFrameUnit
        from alpaca.data.enums import DataFeed
        from datetime import datetime as _dt
        _unit_map = {'Minute': TimeFrameUnit.Minute, 'Hour': TimeFrameUnit.Hour, 'Day': TimeFrameUnit.Day}
        tf = TimeFrame(int(iv_params[0]), _unit_map[iv_params[1]])
        client = StockHistoricalDataClient(ak, as_)
        req = StockBarsRequest(
            symbol_or_symbols=[ticker],
            timeframe=tf,
            start=_dt.strptime(fetch_start, '%Y-%m-%d'),
            end=_dt.strptime(fetch_end,   '%Y-%m-%d'),
            feed=DataFeed.IEX,
        )
        bars = client.get_stock_bars(req).df
        if bars.empty:
            return None
        bars = bars.reset_index()
        # columns: symbol, timestamp, open, high, low, close, volume, ...
        bars = bars.rename(columns={
            'timestamp': 'datetime', 'open': 'Open', 'high': 'High',
            'low': 'Low', 'close': 'Close', 'volume': 'Volume',
        })
        return bars[['datetime', 'Open', 'High', 'Low', 'Close', 'Volume']]
    except Exception as e:
        print(f"  Alpaca error for {ticker}/{interval}: {e}")
        return None


# ── Polygon provider (free tier: ~2 yrs history, 5 req/min) ──────────────────
_POLYGON_INTERVAL_MAP = {
    '1m': (1, 'minute'), '5m': (5, 'minute'), '15m': (15, 'minute'),
    '30m': (30, 'minute'), '1h': (1, 'hour'), '1d': (1, 'day'),
}

def _fetch_polygon(ticker, fetch_start, fetch_end, interval, key=None):
    pk = key or _POLYGON_KEY
    if not pk:
        return None
    iv_params = _POLYGON_INTERVAL_MAP.get(interval)
    if iv_params is None:
        return None
    try:
        from polygon import RESTClient
        import pandas as pd
        client = RESTClient(pk)
        aggs = client.get_aggs(
            ticker=ticker,
            multiplier=iv_params[0],
            timespan=iv_params[1],
            from_=fetch_start,
            to=fetch_end,
            limit=50000,
            adjusted=True,
        )
        if not aggs:
            return None
        rows = []
        for a in aggs:
            rows.append({
                'datetime': pd.Timestamp(a.timestamp, unit='ms', tz='UTC').isoformat(),
                'Open': a.open, 'High': a.high, 'Low': a.low,
                'Close': a.close, 'Volume': a.volume,
            })
        return pd.DataFrame(rows)
    except Exception as e:
        print(f"  Polygon error for {ticker}/{interval}: {e}")
        return None


# ── yfinance provider with interval fallback chain ────────────────────────────
def _fetch_yf_with_fallback(ticker, fetch_start, fetch_end, interval):
    from datetime import datetime as _dt
    age_days = (_dt.now() - _dt.strptime(fetch_start, '%Y-%m-%d')).days
    iv = interval
    while iv is not None:
        if age_days > _INTERVAL_MAX_AGE_DAYS.get(iv, 36500):
            iv = _INTERVAL_FALLBACK.get(iv)
            continue
        try:
            df = yf.download(ticker, start=fetch_start, end=fetch_end,
                             interval=iv, progress=False, auto_adjust=True)
            if not df.empty:
                return df, iv
        except Exception as exc:
            print(f"  yfinance {iv} error for {ticker}: {exc}")
        iv = _INTERVAL_FALLBACK.get(iv)
    return None, None


def _fetch_ohlcv(ticker, fetch_start, fetch_end, interval,
                 alpaca_key=None, alpaca_secret=None, polygon_key=None):
    """Try yfinance first; if it can't serve the interval, try Alpaca then Polygon."""
    from datetime import datetime as _dt
    age_days = (_dt.now() - _dt.strptime(fetch_start, '%Y-%m-%d')).days
    yf_max   = _INTERVAL_MAX_AGE_DAYS.get(interval, 36500)

    # yfinance can handle this interval for this age → use it directly
    if age_days <= yf_max:
        df, actual_iv = _fetch_yf_with_fallback(ticker, fetch_start, fetch_end, interval)
        if df is not None:
            return df, actual_iv, 'yfinance'

    # yfinance can't provide the requested interval → try alternative providers
    print(f"  yfinance cannot serve {interval} for {ticker} ({age_days}d old) → trying Alpaca")
    df = _fetch_alpaca(ticker, fetch_start, fetch_end, interval,
                       key=alpaca_key, secret=alpaca_secret)
    if df is not None:
        return df, interval, 'alpaca'

    print(f"  Alpaca unavailable → trying Polygon")
    df = _fetch_polygon(ticker, fetch_start, fetch_end, interval, key=polygon_key)
    if df is not None:
        return df, interval, 'polygon'

    # All providers failed — fall back to yfinance with a coarser interval
    print(f"  All providers failed for {interval} → yfinance fallback")
    fallback_iv = _INTERVAL_FALLBACK.get(interval, '1d')
    df, actual_iv = _fetch_yf_with_fallback(ticker, fetch_start, fetch_end, fallback_iv)
    if df is not None:
        return df, actual_iv, 'yfinance-fallback'

    return None, None, None


@app.route('/api/stock-history', methods=['POST'])
def get_stock_history():
    data = request.json
    ticker     = data.get('ticker', 'SPY').upper()
    start_date = data.get('start_date', '')
    end_date   = data.get('end_date', '')

    from datetime import datetime, timedelta
    try:
        start_dt = datetime.strptime(start_date, '%Y-%m-%d')
        end_dt   = datetime.strptime(end_date,   '%Y-%m-%d')
    except Exception:
        return jsonify({'error': 'Invalid date format, expected YYYY-MM-DD'}), 400

    # 30-day buffer gives RSI(14) enough warmup candles even for short trades
    buf = timedelta(days=30)
    fetch_start = (start_dt - buf).strftime('%Y-%m-%d')
    fetch_end   = (end_dt   + buf).strftime('%Y-%m-%d')

    # Determine desired interval
    override = data.get('interval', 'auto')
    VALID = {'1m', '2m', '5m', '15m', '30m', '1h', '1d'}
    if override in VALID:
        desired = override
    else:
        age_days = (datetime.now() - start_dt).days
        if age_days <= 5:    desired = '1m'
        elif age_days <= 55: desired = '5m'
        elif age_days <= 720: desired = '1h'
        else:                desired = '1d'

    # Check cache
    cache_key = _cache_key(ticker, fetch_start, fetch_end, desired)
    cached = _load_stock_cache(cache_key, desired)
    if cached:
        cached['from_cache'] = True
        return jsonify(cached)

    # Keys from request body override env vars (user-supplied from the UI)
    req_alpaca_key    = data.get('alpaca_key', '')
    req_alpaca_secret = data.get('alpaca_secret', '')
    req_polygon_key   = data.get('polygon_key', '')

    # Fetch — tries yfinance, then Alpaca, then Polygon, then yfinance with coarser interval
    stock_raw, actual_interval, provider = _fetch_ohlcv(
        ticker, fetch_start, fetch_end, desired,
        alpaca_key=req_alpaca_key, alpaca_secret=req_alpaca_secret,
        polygon_key=req_polygon_key,
    )
    if stock_raw is None:
        return jsonify({'error': f'No price data found for {ticker} (tried yfinance, Alpaca, Polygon)'}), 404

    # Flatten MultiIndex columns yfinance sometimes produces
    if isinstance(stock_raw.columns, pd.MultiIndex):
        stock_raw.columns = [col[0] for col in stock_raw.columns]
    stock_raw = stock_raw.reset_index()
    dt_col = 'Datetime' if 'Datetime' in stock_raw.columns else 'Date'
    stock_raw = stock_raw.rename(columns={dt_col: 'datetime'})

    # VIX — always daily
    vix_raw = yf.download('^VIX', start=fetch_start, end=fetch_end,
                          interval='1d', progress=False, auto_adjust=True)
    if isinstance(vix_raw.columns, pd.MultiIndex):
        vix_raw.columns = [col[0] for col in vix_raw.columns]
    vix_raw = vix_raw.reset_index()
    vix_raw = vix_raw.rename(columns={'Date': 'datetime', 'Datetime': 'datetime'})

    payload = {
        'ticker':     ticker,
        'interval':   actual_interval,
        'requested_interval': desired,
        'provider':   provider,
        'start_date': fetch_start,
        'end_date':   fetch_end,
        'from_cache': False,
        'ohlcv':      _df_to_records(stock_raw[['datetime','Open','High','Low','Close','Volume']]),
        'vix':        _df_to_records(vix_raw[['datetime','Close']].rename(columns={'Close':'vix'})),
    }

    # Persist to cache + timestamped backup
    try:
        _save_stock_cache(cache_key, payload, actual_interval)
    except Exception as ce:
        print(f"  cache write error: {ce}")

    return jsonify(payload)


if __name__ == '__main__':
  app.run(debug=True)
