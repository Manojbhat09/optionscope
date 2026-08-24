# get_rh_options_statement.py
import hashlib
import logging
import os
from datetime import datetime, timezone

import pandas as pd
import robin_stocks.robinhood as rh
from dotenv import load_dotenv
from tqdm import tqdm

from cache_store import FileCacheStore
from range_cache import RangeCoverageCache

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'))

_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))

# Refresh the cached order history if it's older than this before trusting its
# upper bound — new trades can happen at any time, so "covers the requested
# range" must expire even though historical rows never change once fetched.
_REFRESH_TTL_SECONDS = 5 * 60

_orders_cache = RangeCoverageCache(
    FileCacheStore(os.path.join(_BACKEND_DIR, 'orders_cache')),
    refresh_ttl_seconds=_REFRESH_TTL_SECONDS,
)

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')


def _resolve_username(username):
    return username or os.environ.get('ROBINHOOD_USERNAME')


def _account_cache_key(username, namespace='orders'):
    # Hash rather than store the raw email/username as a filename — keeps the
    # cache namespaced per-account (so switching accounts can't serve another
    # account's cached trades) without putting PII on disk as a bare filename.
    digest = hashlib.sha256(username.strip().lower().encode()).hexdigest()[:16]
    return f"{namespace}:{digest}"


def login_to_robinhood(username, password):
    # Fall back to .env defaults when the frontend form was left blank, so
    # robin_stocks never falls back to an interactive input() prompt (which
    # hangs the process when run under `npm start` / concurrently).
    username = _resolve_username(username)
    password = password or os.environ.get('ROBINHOOD_PASSWORD')
    if not username or not password:
        raise ValueError(
            "Robinhood username/password not provided and ROBINHOOD_USERNAME/"
            "ROBINHOOD_PASSWORD are not set in backend/.env"
        )
    logging.info("Logging into Robinhood.")
    rh.login(username=username, password=password)
    return username


def logout_from_robinhood():
    logging.info("Logging out from Robinhood.")
    rh.logout()


def format_date(date_str):
    return datetime.strptime(date_str, '%Y-%m-%dT%H:%M:%S.%fZ').strftime('%Y-%m-%d')


def fetch_option_orders(start_date=None):
    logging.info(f"Fetching option orders from Robinhood (from {start_date or 'account inception'}).")
    start_date_str = start_date.strftime('%Y-%m-%d') if start_date is not None else None
    return rh.orders.get_all_option_orders(start_date=start_date_str)


def process_orders(option_orders):
    logging.info("Processing option orders.")
    orders_data = []
    for order in tqdm(option_orders, desc="Processing Orders", unit="order"):
        activity_date = format_date(order['created_at'])
        process_date = format_date(order['updated_at'])
        instrument = order['chain_symbol']

        for leg in order['legs']:
            if leg['executions']:
                settle_date = leg['executions'][0]['settlement_date']
                quantity = leg['executions'][0]['quantity']
                price = leg['executions'][0]['price']
            else:
                settle_date = None
                quantity = None
                price = None

            description = f"{instrument} {leg['expiration_date']} {leg['option_type']} {leg['strike_price']}" # instrument, date, type, strike
            trans_code = 'BTO' if leg['side'] == 'buy' else 'STC' if leg['side'] == 'sell' else 'OEXP'
            amount = order['processed_premium']

            orders_data.append({
                # Stable identity for this leg, used only to dedupe rows when
                # merging incremental cache syncs — not part of the public API
                # shape, stripped before returning to callers.
                "_leg_id": leg.get('id') or f"{order.get('id')}_{len(orders_data)}",
                "Activity Date": activity_date,
                "Activity DateTime": order['created_at'],  # full ISO timestamp e.g. "2023-05-19T14:30:45.000000Z"
                "Process Date": process_date,
                "Settle Date": settle_date,
                "Instrument": instrument,
                "Description": description,
                "Trans Code": trans_code,
                "Quantity": quantity,
                "Price": price,
                "Amount": amount
            })
    return pd.DataFrame(orders_data)


def get_orders_for_range(cache_key, start_date, end_date):
    """Return processed option-order-leg rows covering [start_date, end_date]
    for this account, using the coverage cache so a repeat "fetch data" call
    doesn't re-paginate Robinhood's full order history every time:
      - fully covered by a fresh cache entry -> served locally, no API call.
      - cache reaches back far enough but is stale -> incremental sync from
        the cached upper bound only (fast — a handful of pages, not all of
        them).
      - cache doesn't reach back far enough -> full fetch from `start_date`
        (Robinhood's API has no way to fetch an isolated older slice, so this
        case can't be made incremental; it only happens once per new,
        earlier start_date, after which it's cached going forward).
    """
    start_str = start_date.strftime('%Y-%m-%d')
    end_str = end_date.strftime('%Y-%m-%d')

    lookup = _orders_cache.lookup(cache_key, start_str, end_str)

    if lookup.covers_request:
        logging.info("Order cache fully covers the requested range — serving locally, no Robinhood call.")
    else:
        fetch_from = lookup.sync_from
        if fetch_from == start_str:
            # sync_from == start means the cache either doesn't exist or doesn't
            # reach back far enough — no way to avoid a full fetch from `start`.
            reason = "none cached yet" if lookup.rows is None else f"cached range doesn't reach back to {start_str}"
            logging.info(f"Full fetch from {fetch_from} ({reason}).")
        else:
            logging.info(f"Order cache already covers back to {start_str} — incremental sync from {fetch_from} "
                          f"instead of a full refetch.")

        option_orders = fetch_option_orders(start_date=pd.to_datetime(fetch_from))
        new_rows = process_orders(option_orders).to_dict('records')
        today_str = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        _orders_cache.put(
            cache_key, new_rows,
            covered_start=fetch_from, covered_end=today_str,
            dedupe_key=lambda r: r['_leg_id'],
        )

    entry = _orders_cache.store.get(cache_key)
    rows = entry['rows'] if entry else []
    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(rows).drop(columns=['_leg_id'])
    df['Activity Date'] = pd.to_datetime(df['Activity Date'])
    df['Process Date'] = pd.to_datetime(df['Process Date'])
    mask = (df['Activity Date'] >= start_date) & (df['Activity Date'] <= end_date)
    return df[mask].sort_values('Activity Date').reset_index(drop=True)


def fetch_and_update_orders(username, password, start_date, end_date, csv_file='orders'):
    resolved_username = login_to_robinhood(username, password)
    try:
        cache_key = _account_cache_key(resolved_username, namespace=csv_file)
        return get_orders_for_range(cache_key, pd.to_datetime(start_date), pd.to_datetime(end_date))
    finally:
        try:
            logout_from_robinhood()
        except Exception:
            print("Failed logging out")


def delete_cache(csv_file='orders', username=None):
    resolved_username = _resolve_username(username)
    if not resolved_username:
        raise ValueError("Cannot clear the order cache without a username (none provided and "
                          "ROBINHOOD_USERNAME is not set in backend/.env)")
    _orders_cache.delete(_account_cache_key(resolved_username, namespace=csv_file))
