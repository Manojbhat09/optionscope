import pandas as pd

# Load the data
data = [
    ["2024-01-08", "2024-01-08", "2024-01-09", "AAPL", "AAPL 1/12/2024 Call $182.50", "BTO", 1, 2.56, -256.03],
    ["2024-01-08", "2024-01-08", "2024-01-09", "TSLA", "TSLA 1/12/2024 Put $230.00", "STC", 1, 2.00, 199.95],
    ["2024-01-08", "2024-01-08", "2024-01-09", "NVDA", "NVDA 1/12/2024 Put $512.50", "BTO", 1, 7.45, -745.03],
    ["2024-01-08", "2024-01-08", "2024-01-09", "TSLA", "TSLA 1/12/2024 Put $230.00", "BTO", 1, 1.68, -168.03],
    ["2024-01-08", "2024-01-08", "2024-01-09", "SNAP", "SNAP 1/12/2024 Call $16.50", "STC", 10, 0.80, 799.66],
    ["2024-01-08", "2024-01-08", "2024-01-09", "NVDA", "NVDA 1/12/2024 Put $510.00", "BTO", 1, 8.50, -850.03],
    ["2024-01-08", "2024-01-08", "2024-01-09", "AMZN", "AMZN 1/12/2024 Call $148.00", "STC", 4, 1.70, 679.86],
]

# Convert the data to a pandas DataFrame
columns = ["Activity Date", "Process Date", "Settle Date", "Instrument", "Description", "Trans Code", "Quantity", "Price", "Amount"]
df = pd.DataFrame(data, columns=columns)

# Calculate the profit or loss for each trade
df["Profit/Loss"] = df["Amount"]

# Calculate the total profit or loss
total_profit_loss = df["Profit/Loss"].sum()

# Print the results
print("Total Profit/Loss:", total_profit_loss)

# Calculate the average profit or loss
average_profit_loss = df["Profit/Loss"].mean()

# Print the results
print("Average Profit/Loss:", average_profit_loss)

# Calculate the number of profitable and unprofitable trades
profitable_trades = df[df["Profit/Loss"] > 0].shape
unprofitable_trades = df[df["Profit/Loss"] < 0].shape

# Print the results
print("Profitable Trades:", profitable_trades)
print("Unprofitable Trades:", unprofitable_trades)
