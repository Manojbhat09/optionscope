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


@app.route('/api/stock-history', methods=['POST'])
def get_stock_history():
    data = request.json
    ticker     = data.get('ticker', 'SPY').upper()
    start_date = data.get('start_date', '')   # YYYY-MM-DD  (trade open date)
    end_date   = data.get('end_date', '')     # YYYY-MM-DD  (trade close date)

    from datetime import datetime, timedelta
    try:
        start_dt = datetime.strptime(start_date, '%Y-%m-%d')
        end_dt   = datetime.strptime(end_date,   '%Y-%m-%d')
    except Exception:
        return jsonify({'error': 'Invalid date format, expected YYYY-MM-DD'}), 400

    # Add a 5-day buffer on each side so candles before/after the trade are visible
    buf = timedelta(days=5)
    fetch_start = (start_dt - buf).strftime('%Y-%m-%d')
    fetch_end   = (end_dt   + buf).strftime('%Y-%m-%d')

    # Interval: honour explicit override, otherwise pick by age
    override = data.get('interval', 'auto')
    VALID = {'1m', '2m', '5m', '15m', '30m', '1h', '1d'}
    if override in VALID:
        interval = override
    else:
        age_days = (datetime.now() - start_dt).days
        if age_days <= 5:
            interval = '1m'
        elif age_days <= 55:
            interval = '5m'
        elif age_days <= 720:
            interval = '1h'
        else:
            interval = '1d'

    def df_to_records(df):
        records = []
        for _, row in df.iterrows():
            rec = {}
            for col in df.columns:
                val = row[col]
                if pd.isna(val):
                    rec[col] = None
                elif hasattr(val, 'isoformat'):
                    rec[col] = val.isoformat()
                elif isinstance(val, (np.floating, np.integer)):
                    rec[col] = float(val)
                else:
                    rec[col] = val
            records.append(rec)
        return records

    try:
        stock_raw = yf.download(ticker, start=fetch_start, end=fetch_end,
                                interval=interval, progress=False, auto_adjust=True)
        if stock_raw.empty:
            return jsonify({'error': f'No price data found for {ticker}'}), 404

        # Flatten MultiIndex columns yfinance sometimes produces
        if isinstance(stock_raw.columns, pd.MultiIndex):
            stock_raw.columns = [col[0] for col in stock_raw.columns]

        stock_raw = stock_raw.reset_index()
        # Normalise date/datetime column name
        dt_col = 'Datetime' if 'Datetime' in stock_raw.columns else 'Date'
        stock_raw = stock_raw.rename(columns={dt_col: 'datetime'})

        # VIX — always daily (intraday VIX isn't available on yfinance)
        vix_raw = yf.download('^VIX', start=fetch_start, end=fetch_end,
                              interval='1d', progress=False, auto_adjust=True)
        if isinstance(vix_raw.columns, pd.MultiIndex):
            vix_raw.columns = [col[0] for col in vix_raw.columns]
        vix_raw = vix_raw.reset_index()
        vix_raw = vix_raw.rename(columns={'Date': 'datetime', 'Datetime': 'datetime'})

        return jsonify({
            'ticker':     ticker,
            'interval':   interval,
            'start_date': fetch_start,
            'end_date':   fetch_end,
            'ohlcv':      df_to_records(stock_raw[['datetime','Open','High','Low','Close','Volume']]),
            'vix':        df_to_records(vix_raw[['datetime','Close']].rename(columns={'Close':'vix'})),
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
  app.run(debug=True)
