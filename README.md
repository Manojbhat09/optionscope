<div align="center">
  <img src="https://your-logo-url-here.png" alt="OptionScope Logo" width="200"/>
  <h1>🚀 OptionScope 📊</h1>
  <h3>Robinhood Options Performance Dashboard</h3>
  <p><em>Elevate Your Options Trading with Data-Driven Insights</em></p>

  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
  [![React](https://img.shields.io/badge/React-17.0.2-blue.svg)](https://reactjs.org/)
  [![Flask](https://img.shields.io/badge/Flask-2.0.1-green.svg)](https://flask.palletsprojects.com/)
</div>


Supercharge your Robinhood options trading strategy with data-driven insights! 🚀
The **Options Trading Analysis Dashboard** is a powerful web application designed for options traders who want to understand and improve their trading performance. By securely fetching your options trading data directly from Robinhood, this dashboard provides in-depth analytics, interactive visualizations, and a platform for you to reflect, take notes, and develop better trading strategies.


Whether you're a seasoned options trader or just getting started, this tool helps you:

- Analyze your trading history in detail.
- Visualize profit and loss trends over time.
- Identify your most profitable instruments and strategies.
- Keep track of your thoughts and strategies with integrated note-taking.


## 🌟 Features


- 📈 **Secure Data Fetching**: Log in with your Robinhood credentials to fetch your options trading history within a specified date range.
- 🏆 **Comprehensive Analytics**:
  - **Total Profit/Loss** calculations.
  - **Win Rate** and **Total Trades** overview.
  - **Profit/Loss by Instrument**: Identify which assets are driving your performance.
  - **Profit/Loss by Option Type**: Understand whether calls or puts are more profitable for you.
  - **Revenue Analysis by Instrument**.
  - **Cumulative Profit/Loss Over Time**: See how your P/L evolves.
  - **Top Profitable and Loss-Making Trades**: Learn from your best and worst trades.
- 📊 **Interactive Visualizations**: Utilize charts and graphs powered by Recharts for an intuitive analysis experience.
- 🗓️ **Customizable Date Range**: Focus your analysis on specific periods to see how strategies performed over time.
- 📝 **Trading Notes**:
  - Integrated note-taking section with Markdown support.
  - Export notes as Markdown files.
  - Save and load notes for continuous strategizing and refer back when needed.
- 💾 **CSV Upload Option**: Alternatively, upload your trading data via CSV if you prefer not to connect your Robinhood account.
- 💹 **Responsive Design**: Access the dashboard from desktop or mobile devices.



### Prerequisites

- **Node.js** (v14 or higher)
- **Python** (v3.6 or higher)
- **Robinhood Account Credentials**


## 🚀 Quick Start

1. Clone the repository:
   ```
   git clone https://github.com/yourusername/options-trading-dashboard.git
   ```

2. Install dependencies:
   ```
   cd options-trading-dashboard
   npm install
   pip install -r backend/requirements.txt
   ```

3. Start the development server:
   ```
   npm start
   ```

4. Open your browser and navigate to `http://localhost:3000`

## 🖥️ Usage

### Fetching Data from Robinhood

1. **Enter Credentials**:

   - **Username**: Your Robinhood account email.
   - **Password**: Your Robinhood account password.
   - **Start Date**: The beginning date for your trading data.
   - **End Date**: The ending date for your trading data.

2. **Fetch Data**:

   - Click the **"Fetch Data"** button.
   - The app will securely authenticate with Robinhood and retrieve your options trading history.

### Analyzing Your Trades

Once data is fetched:

- **Summary Overview**:

  - **Total Profit/Loss**: Net earnings from your trades.
  - **Total Profit**: Sum of all profitable trades.
  - **Total Loss**: Sum of all losing trades.
  - **Win Rate**: Percentage of trades that were profitable.
  - **Total Trades**: Number of trades made.

- **Charts and Graphs**:

  - **Profit/Loss by Instrument**: Bar chart showing P/L for each traded instrument.
  - **Revenue by Instrument**: Understand which instruments generate the most revenue.
  - **Profit/Loss by Option Type**: Pie chart comparing calls vs. puts.
  - **Cumulative Profit/Loss Over Time**: Line chart of your P/L progression.
  - **Holding Period Analysis**: Insights into the duration of your trades.

- **Top Trades**:

  - **Top Profitable Trades**: Review your best trades.
  - **Top Loss-Making Trades**: Identify and learn from your biggest losses.

### Reviewing Individual Trades

Scroll down to view a detailed table containing all your trades, including:

- Activity Date
- Instrument
- Description
- Transaction Code
- Quantity
- Strike Price
- Price
- Amount

### Trading Notes

- **Edit Notes**:

  - Click on **"Edit"** to modify your trading notes.
  - Notes support **Markdown** formatting for rich text features.

- **Save Notes**:

  - After editing, click **"Save"** to store your notes locally.

- **Export Notes**:

  - Click **"Export as MD"** to download your notes as a Markdown file.

- **Reset or Clear Notes**:

  - **Reset to Default**: Restore the original sample notes.
  - **Clear Notes**: Remove all notes.

### Adjusting Data Range

- Use the **row sliders** to adjust the range of data analyzed.
- Date range and row numbers are displayed for clarity.

### Uploading CSV Data (Optional)

- Click on **"Upload CSV"** to select and upload a CSV file containing your trading data.
- The CSV should have columns similar to those fetched from Robinhood.

## Security Notice

- **Credentials Usage**:

  - Your Robinhood **username and password** are used **only** to fetch your trading data.
  - **Credentials are not stored** on any server or sent to any third party.
  - Data fetching happens over secure connections directly with Robinhood's API.

- **Data Privacy**:

  - All fetched data is processed locally on your machine.
  - No trading data is uploaded or stored externally.

- **Important**:

  - Always ensure you **trust the application** before entering your credentials.
  - **Review the source code** if in doubt, particularly `backend/app.py` and `backend/get_rh_options_app.py`.



## 🔮 Future Features

We're constantly working to improve the Options Trading Analysis Dashboard. Here are some exciting features on our roadmap:

- 🤖 AI-powered trade recommendations based on historical performance
- 🌐 Integration with multiple brokers beyond Robinhood
- 📱 Mobile app for on-the-go analysis
- 🔔 Real-time alerts for potential profit-taking or loss-cutting opportunities
- 🧠 Machine learning models to predict option price movements
- 🗂️ Custom tagging system for categorizing and filtering trades
- 🔄 Backtesting functionality to simulate strategies on historical data
- 👥 Social features to share and compare trading strategies (anonymously)

## Roadmap

- **Integration with Other Brokers**: Support for TD Ameritrade, E*TRADE, etc.
- **Advanced Analytics**: Add more metrics like Sharpe ratio, volatility analysis.
- **Real-Time Data**: Incorporate live data feeds for real-time strategy testing.
- **Cloud Deployment**: Options to deploy the dashboard on cloud platforms.

## 🤝 Contributing

We welcome contributions from the community! If you'd like to contribute, please:

1. Fork the repository
2. Create a new branch for your feature
3. Commit your changes
4. Push to your branch
5. Open a pull request

- **Bug Reports & Feature Requests**: Open an issue on GitHub.
- **Pull Requests**: Feel free to fork the repository and submit pull requests.
- **Feedback**: Your feedback helps improve the tool for everyone.



## 📜 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgements

- [Robinhood API](https://github.com/robinhood-unofficial/pyrh) for providing access to trading data
- [React](https://reactjs.org/) for the frontend framework
- [Flask](https://flask.palletsprojects.com/) for the backend server
- [Recharts](https://recharts.org/) for beautiful, responsive charts

---

Happy trading! 📈💰 May your options always be in the money!


