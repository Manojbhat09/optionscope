import React, { useState, useEffect } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceDot } from 'recharts';
import axios from 'axios';

const parseOptionData = (trades) => {
  const profitLoss = {};
  trades.forEach(trade => {
    // Check for required fields
    if (!trade.Instrument || !trade.Description || !trade["Trans Code"] || trade["Trans Code"] === null) {
      console.log("Skipping trade due to missing or invalid Trans Code:", trade);
      return;
    }

    if (trade.Amount === 0) {
      console.log("Skipping trade due to amount of 0:", trade);
      return;
    }

    if (!trade.Quantity || trade.Quantity === null) {
      console.log("Skipping trade due to missing or invalid Quantity:", trade);
      return;
    }

    const parts = trade.Description.split(' ');
    let instrument, expiry, type, strike;

    // Correctly parse the description
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];

      if (i === 0) {
        instrument = part;
      } else if (part.includes('/') || part.includes('-')) {
        expiry = part;
      } else if (part === 'Call' || part === 'Put' || part === 'call' || part === 'put') {
        type = part;
      } else if (!isNaN(parseFloat(part))) { // Check if the part is a number
        strike = part;
      }
    }

    // Ensure all necessary parts are extracted
    if (!expiry || !type || !strike) {
      console.log("Skipping trade due to invalid description:", trade);
      return;
    }

    const key = `${trade.Instrument}_${expiry}_${type}_${strike}`;
    if (!profitLoss[key]) {
      profitLoss[key] = {
        instrument: trade.Instrument,
        expiry,
        type,
        strike,
        buyQuantity: 0,
        sellQuantity: 0,
        buyAmount: 0,
        sellAmount: 0,
        pl: 0,
        openDate: null,
        closeDate: null,
        expiryDate: null,
        sign: 1,
        revenue: 0,
      };
    }

    // Update quantities and amounts
    if (trade["Trans Code"] === 'Buy' || trade["Trans Code"] === 'buy') {
      profitLoss[key].buyQuantity += trade.Quantity;
      profitLoss[key].buyAmount += trade.Amount;
    } else if (trade["Trans Code"] === 'Sell' || trade["Trans Code"] === 'sell') {
      profitLoss[key].sellQuantity += trade.Quantity;
      profitLoss[key].sellAmount += trade.Amount;
    }

    // Calculate profit/loss
    profitLoss[key].pl = profitLoss[key].sellAmount - profitLoss[key].buyAmount;

    // Update dates
    if (!profitLoss[key].openDate || profitLoss[key].openDate > trade['Activity Date']) {
      profitLoss[key].openDate = trade['Activity Date'];
    }
    if (!profitLoss[key].closeDate || profitLoss[key].closeDate < trade['Settle Date']) {
      profitLoss[key].closeDate = trade['Settle Date'];
    }
    profitLoss[key].expiryDate = expiry;

    // Determine sign based on type (Call/Put)
    profitLoss[key].sign = type === 'call' ? 1 : -1;
  });

  // Convert profitLoss object to array
  const optionData = Object.values(profitLoss).map(option => ({
    date: option.openDate,
    closedate: option.closeDate, 
    price: option.strike, // Average price per unit option.pl / option.buyQuantity,
    type: option.type,
  }));

  return optionData;
};

const StockPlot = ({ username, password, ticker, startDate, endDate }) => {
  const [data, setData] = useState({ stockData: [], optionData: [] });

  useEffect(() => {
    const fetchData = async () => {
      try {
        const response = await axios.post('http://localhost:5000/api/stock-data', {
          username,
          password,
          ticker,
          startDate,
          endDate
        });
        setData(response.data);
      } catch (error) {
        console.error('Error fetching stock data:', error);
      }
    };

    fetchData();
  }, [username, password, ticker, startDate, endDate]);

  // Parse option data
  const parsedOptionData = parseOptionData(data.optionData);
  

  // Calculate min and max values for YAxis domain
  const minY = data.stockData.length > 0 ? Math.min(...data.stockData.map(item => item.Close)) : 0;
  const maxY = data.stockData.length > 0 ? Math.max(...data.stockData.map(item => item.Close)) : 0;

// Convert stockData dates to ISO strings without time
  const stockDataWithDate = data.stockData.map(item => ({
    ...item,
    Datetime: new Date(item.Datetime).toISOString().split('T')[0] // Extract date part only
  }));

// Function to find the index in stockData for a given date
  const findIndex = (date) => {
    return stockDataWithDate.findIndex(item => item.Datetime === date);
  };
  const findDatetime = (date) => {
    if(stockDataWithDate.findIndex(item => item.Datetime === date) == -1)
      return -1
    return data.stockData[stockDataWithDate.findIndex(item => item.Datetime === date)]['Datetime'];
  };
  const findValue = (date) => {
    if(stockDataWithDate.findIndex(item => item.Datetime === date) == -1)
      return -1
    return stockDataWithDate[stockDataWithDate.findIndex(item => item.Datetime === date)]['Close'];
  };

  // Map option dates to indices in stockData
  const optionDatesWithOpenIndex = parsedOptionData.map(option => ({
    ...option,
    index: findIndex(option.date),
    xDatetime: findDatetime(option.date), 
    value: findValue(option.date)
  }));

  const optionDatesWithCloseIndex = parsedOptionData.map(option => ({
    ...option,
    index: findIndex(option.closedate),
    xDatetime: findDatetime(option.closedate), 
    value: findValue(option.closedate)
  }));

// Filter out options without a matching index
  const filteredOptionOpenDates = optionDatesWithOpenIndex.filter(option => option.index !== -1);
  const filteredOptionCloseDates = optionDatesWithCloseIndex.filter(option => option.index !== -1);

  // Custom legend content
  const customLegendContent = (
    <div className="custom-legend">
      <div>
        <span style={{ backgroundColor: 'green', width: '10px', height: '10px', display: 'inline-block', borderRadius: '50%' }} />
        <span>Call to Open (Radius 10)</span>
      </div>
      <div>
        <span style={{ backgroundColor: 'red', width: '10px', height: '10px', display: 'inline-block', borderRadius: '50%' }} />
        <span>Put to Open (Radius 10)</span>
      </div>
      <div>
        <span style={{ backgroundColor: 'green', width: '5px', height: '5px', display: 'inline-block', borderRadius: '50%' }} />
        <span>Call to Close (Radius 5)</span>
      </div>
      <div>
        <span style={{ backgroundColor: 'red', width: '5px', height: '5px', display: 'inline-block', borderRadius: '50%' }} />
        <span>Put to Close (Radius 5)</span>
      </div>
    </div>
  );

  return (
    <ResponsiveContainer width="100%" height={400}>
      <LineChart data={data.stockData}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="Datetime" />
        <YAxis domain={[minY, maxY]} />
        <Tooltip />
        <Legend content={customLegendContent} />
        <Line type="monotone" dataKey="Close" stroke="#8884d8" />{}
        {filteredOptionOpenDates.map((option, index) => (
          <ReferenceDot
            key={index}
            x={option.xDatetime}
            y={option.value}
            r={10}
            fill={option.type === 'call' ? '#82ca9d' : '#ff7300'}
            stroke="none"
          />
        ))}

        {filteredOptionCloseDates.map((option, index) => (
          <ReferenceDot
            key={index}
            x={option.xDatetime}
            y={option.value}
            r={5}
            fill={option.type === 'call' ? '#82ca9d' : '#ff0101'}
            stroke="none"
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
};

export default StockPlot;

        