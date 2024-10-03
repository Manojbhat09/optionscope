# app.py
from flask import Flask, request, jsonify
from get_rh_options_app import fetch_and_update_orders
from flask_cors import CORS
import pandas as pd 
import numpy as np 

app = Flask(__name__)
CORS(app)

@app.route('/api/fetch-data', methods=['POST'])
def fetch_data():
  data = request.json
  username = data.get('username')
  password = data.get('password')
  start_date = data.get('startDate')
  end_date = data.get('endDate')
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

if __name__ == '__main__':
  app.run(debug=True)
