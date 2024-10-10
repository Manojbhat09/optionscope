# app.py
from flask import Flask, request, jsonify
from get_rh_options_app import fetch_and_update_orders, delete_cache
import robin_stocks.robinhood as r
from flask_cors import CORS
import pandas as pd 
import numpy as np 
import yfinance as yf
app = Flask(__name__)
CORS(app)


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
      filtered_orders = pd.DataFrame(filtered_orders)
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
                      # print(record[key])
                  except Exception as e:
                      print(f"Error formatting date for {key}: {value} - {e}")
                  # if isinstance(value, str):
                  #     # Convert to datetime and format as YYYY-MM-DD
                      
                  # else:
                  #   print("date: ", value)

      return jsonify(filtered_orders.to_dict(orient='records'))
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
        filtered_orders = pd.DataFrame(filtered_orders)
        records = filtered_orders.to_dict(orient='records')
        for record in records:
            for key, value in record.items():
                if isinstance(value, (int, float, np.float64, np.int64)):
                    record[key] = str(value)
                elif pd.isna(value):
                    record[key] = None
                elif key in ['Activity Date', 'Process Date', 'Settle Date']:
                    try:
                        record[key] = str(pd.to_datetime(value).strftime('%Y-%m-%d'))
                    except Exception as e:
                        print(f"Error formatting date for {key}: {value} - {e}")
        return jsonify(filtered_orders.to_dict(orient='records'))
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
  app.run(debug=True)
