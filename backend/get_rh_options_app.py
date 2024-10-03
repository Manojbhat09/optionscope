# get_rh_options_statement.py
import os
import pandas as pd
from datetime import datetime
import robin_stocks.robinhood as rh
import pickle
import logging
from tqdm import tqdm

# Constants
CACHE_FILE = 'option_orders_cache.pkl'
CSV_FILE = 'orders.csv'

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

def login_to_robinhood(username, password):
  logging.info("Logging into Robinhood.")
  rh.login(username=username, password=password)

def logout_from_robinhood():
  logging.info("Logging out from Robinhood.")
  rh.logout()

def load_cached_data(filename):
  if os.path.exists(filename):
      logging.info(f"Loading cached data from {filename}.")
      with open(filename, 'rb') as f:
          return pickle.load(f)
  logging.info("No cached data found.")
  return None

def save_data_to_cache(data, filename):
  logging.info(f"Saving data to cache in {filename}.")
  with open(filename, 'wb') as f:
      pickle.dump(data, f)

def load_csv_data(filename):
  if os.path.exists(filename):
      logging.info(f"Loading CSV data from {filename}.")
      return pd.read_csv(filename)
  logging.info("No CSV data found.")
  return pd.DataFrame()

def save_csv_data(data, filename):
  logging.info(f"Saving data to CSV in {filename}.")
  data.to_csv(filename, index=False)

def format_date(date_str):
  return datetime.strptime(date_str, '%Y-%m-%dT%H:%M:%S.%fZ').strftime('%Y-%m-%d')

def fetch_option_orders():
  logging.info("Fetching option orders from Robinhood.")
  option_orders = rh.orders.get_all_option_orders()
  save_data_to_cache(option_orders, CACHE_FILE)
  return option_orders

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
              "Activity Date": activity_date,
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

def update_csv_cache(start_date, end_date, csv_file=CSV_FILE):
  logging.info("Updating CSV cache.")
  csv_data = load_csv_data(csv_file)
  if not csv_data.empty:
      csv_data['Activity Date'] = pd.to_datetime(csv_data['Activity Date'])
      csv_data['Process Date'] = pd.to_datetime(csv_data['Process Date'])
      date_range = (csv_data['Activity Date'] >= start_date) & (csv_data['Activity Date'] <= end_date)
      if date_range.any():
          logging.info("Data already exists in the specified date range.")
          return csv_data[date_range]

  option_orders = load_cached_data(CACHE_FILE)
  if option_orders is None:
      option_orders = fetch_option_orders()

  new_data = process_orders(option_orders)
  new_data['Activity Date'] = pd.to_datetime(new_data['Activity Date'])
  new_data['Process Date'] = pd.to_datetime(new_data['Process Date'])
  new_data = new_data[(new_data['Activity Date'] >= start_date) & (new_data['Activity Date'] <= end_date)]

  if not csv_data.empty:
      combined_data = pd.concat([csv_data, new_data]).drop_duplicates().reset_index(drop=True)
  else:
      combined_data = new_data
  # Sort the combined data by 'Activity Date'
  combined_data = combined_data.sort_values(by='Activity Date').reset_index(drop=True)

  save_csv_data(combined_data, csv_file)
  logging.info("Data has been updated in the CSV file.")
  return combined_data

def fetch_and_update_orders(username, password, start_date, end_date, csv_file=CSV_FILE):
  login_to_robinhood(username, password)
  try:
      return update_csv_cache(pd.to_datetime(start_date), pd.to_datetime(end_date), csv_file)
  finally:
      logout_from_robinhood()
