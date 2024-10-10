import React, { useState, useEffect } from 'react';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { Card, CardContent, CardHeader, Select, MenuItem, TextField, Button, Typography, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper } from '@mui/material';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell } from 'recharts';
import axios from 'axios';
import TradingNotes from './tradingnotes'; // Import the TradingNotes component
import StockPlot from './StockPlot';
const theme = createTheme();


const parseCSV = (csvString) => {
  const lines = csvString.split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const values = line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    return headers.reduce((obj, header, index) => {
      let value = values[index];
      if (header === 'Amount') {
        value = value.replace(/"/g, '').replace(/,/g, '');
      }
      obj[header.trim()] = value ? value.trim() : '';
      return obj;
    }, {});
  });
};

function parseDescription(description) {
  const parts = description.split(' ');
  let instrument, desc = '', expiry, type, strike;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    if (i === 0) {
      instrument = part;
    } else if (part.includes('/')) {
      expiry = part;
    } else if (part === 'Call' || part === 'Put') {
      type = part;
    } else if (part.startsWith('$')) {
      strike = part.replace('$', '');
    } else {
      desc += part + ' ';
    }
  }

  return { instrument, expiry, type, strike };
}

// const calculateProfitLoss = (trades) => {
//   const profitLoss = {};
//   trades.forEach(trade => {
//     if (!trade.Instrument || !trade.Description || !trade["Trans Code"]) return;

//     const parts = trade.Description.split(' ');
//     let instrument, desc = '', expiry, type, strike;

//     for (let i = 0; i < parts.length; i++) {
//       const part = parts[i];

//       if (i === 0) {
//         // instrument = part;
//       } else if (part.includes('/')) {
//         expiry = part;
//       } else if (part === 'Call' || part === 'Put') {
//         type = part;
//       } else if (part.startsWith('$')) {
//         strike = part.replace('$', '');
//       } else {
//         desc += part + ' ';
//       }
//     }

//     if (!expiry || !type || !strike) return;

//     const key = `${trade.Instrument}_${expiry}_${type}_${strike}`;
//     if (!profitLoss[key]) {
//       profitLoss[key] = {
//         instrument: trade.Instrument,
//         expiry,
//         type,
//         strike,
//         buyQuantity: 0,
//         sellQuantity: 0,
//         buyAmount: 0,
//         sellAmount: 0,
//         pl: 0,
//         openDate: null,
//         closeDate: null,
//         expiryDate: null,
//         sign: 1,
//         revenue: 0,
//       };
//     }

//     const quantity = parseFloat(trade.Quantity) || 0;
//     let amount = '0';
//     if (typeof trade.Amount === 'string') {
//       amount = Number(trade.Amount.replace(/[^\d.-]/g, '')); // Convert the string to a number after removing non-numeric characters
//     } else {
//       amount = trade.Amount; // Use the number as it is if it's already a number
//     }
//     amount = parseFloat(amount);

//     const totalStrike = amount;
//     const totalCost = amount;

//     const date = new Date(trade["Activity Date"]);

//     if (trade["Trans Code"] === "BTO") {
//       profitLoss[key].buyQuantity += quantity;
//       profitLoss[key].buyAmount += totalStrike;
//       if (!profitLoss[key].openDate || date < profitLoss[key].openDate) {
//         profitLoss[key].openDate = date;
//       }
//     } else if (trade["Trans Code"] === "STC") {
//       profitLoss[key].sellQuantity += quantity;
//       profitLoss[key].sellAmount += totalCost;
//       if (!profitLoss[key].closeDate || date > profitLoss[key].closeDate) {
//         profitLoss[key].closeDate = date;
//       }
//     }

//     if (trade["Trans Code"] === "OEXP" || desc.toLowerCase().indexOf("exp") === 1) {
//       profitLoss[key].sellAmount = 0;
//       profitLoss[key].sellQuantity = profitLoss[key].buyQuantity;
//       profitLoss[key].pl = profitLoss[key].sellAmount - profitLoss[key].buyAmount;
//       profitLoss[key].expiryDate = new Date(trade["Process Date"]);
//     }

//     if (isNaN(profitLoss[key].sellAmount) || isNaN(profitLoss[key].buyAmount)) {
//       console.error(`Invalid profit/loss calculation for trade: ${trade.Description}`);
//       profitLoss[key].pl = 0;
//     } else {
//       profitLoss[key].pl = profitLoss[key].sellAmount - profitLoss[key].buyAmount;
//     }

//     profitLoss[key].revenue = profitLoss[key].sellAmount;

//     if (profitLoss[key].pl > 0) {
//       profitLoss[key].type = type;
//     }
//   });
//   console.log(profitLoss);
//   return Object.values(profitLoss);
// };

const calculateProfitLoss = (trades) => {
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

    const quantity = parseFloat(trade.Quantity) || 0;
    let amount = '0';
    if (typeof trade.Amount === 'string') {
      amount = Number(trade.Amount.replace(/[^\d.-]/g, '')); // Convert the string to a number after removing non-numeric characters
    } else {
      amount = trade.Amount; // Use the number as it is if it's already a number
    }
    amount = parseFloat(amount);
    // amount = trade.Amount === 0 && trade.TransCode === 'OEXP' ? -trade.Quantity * trade.Price : trade.Amount;

    const totalStrike = amount;
    const totalCost = amount;

    const date = new Date(trade["Activity Date"]);

    if (trade["Trans Code"] === "BTO") {
      profitLoss[key].buyQuantity += quantity;
      profitLoss[key].buyAmount += totalStrike;
      if (!profitLoss[key].openDate || date < profitLoss[key].openDate) {
        profitLoss[key].openDate = date;
      }
    } else if (trade["Trans Code"] === "STC") {
      profitLoss[key].sellQuantity += quantity;
      profitLoss[key].sellAmount += totalCost;
      profitLoss[key].revenue = profitLoss[key].sellAmount; // Update revenue for STC trades
      if (!profitLoss[key].closeDate || date > profitLoss[key].closeDate) {
        profitLoss[key].closeDate = date;
      }
    }

    if (trade["Trans Code"] === "OEXP" || trade.Description.toLowerCase().includes("exp")) {
      profitLoss[key].sellAmount = 0;
      profitLoss[key].sellQuantity = profitLoss[key].buyQuantity;
      // profitLoss[key].pl = profitLoss[key].sellAmount - profitLoss[key].buyAmount;
      profitLoss[key].pl = -profitLoss[key].buyAmount; // Update P/L for expired trades
      profitLoss[key].revenue = 0; // Set revenue to 0 for expired trades
      profitLoss[key].expiryDate = new Date(trade["Process Date"]);
    }

    if (isNaN(profitLoss[key].sellAmount) || isNaN(profitLoss[key].buyAmount)) {
      console.error(`Invalid profit/loss calculation for trade: ${trade.Description}`);
      profitLoss[key].pl = 0;
    } else {
      profitLoss[key].pl = profitLoss[key].sellAmount - profitLoss[key].buyAmount;
    }


    if (profitLoss[key].pl > 0) {
      profitLoss[key].type = type;
    }
  });
  // console.log(profitLoss);
  return Object.values(profitLoss);
};

const OptionsTradingDashboard = () => {
  const [csvData, setCsvData] = useState([]);
  const [profitLossData, setProfitLossData] = useState([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [startDate, setStartDate] = useState('2023-01-01');
  const [endDate, setEndDate] = useState('2023-12-31');
  const [instrumentSort, setInstrumentSort] = useState('none');
  const [revenueSort, setRevenueSort] = useState('none');
  const [transactionSort, setTransactionSort] = useState('none');
  const [selectedInstrument, setSelectedInstrument] = useState('All');
  const [dateRange, setDateRange] = useState({ start: '', end: '' });
  const [file, setFile] = useState(null);
  const [timeSeriesData, setTimeSeriesData] = useState([]);
  const [sliceStart, setSliceStart] = useState(0);
  const [sliceEnd, setSliceEnd] = useState(csvData.length);
  const [notes, setNotes] = useState('');
  const [selectedTicker, setSelectedTicker] = useState('');
  const [startStockPlotDate, setStartStockPlotDate] = useState('');
  const [endStockPlotDate, setEndStockPlotDate] = useState('');
  const [datespacingInput, setDatespacingInput] = useState('10');
  const [displayPlot, setDisplayPlot] = useState(false);

const parseCSV = (csvString) => {
  const lines = csvString.split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const values = line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    return headers.reduce((obj, header, index) => {
      let value = values[index];
      if (header === 'Amount') {
        value = value.replace(/"/g, '').replace(/,/g, '');
      }
      obj[header.trim()] = value ? value.trim() : '';
      return obj;
    }, {});
  });
};


  const handleFetchData = async () => {
    try {
      const response = await axios.post('http://localhost:5000/api/fetch-data', {
        username,
        password,
        startDate,
        endDate,
      });
      // console.log('Response data:', response.data); // This will print in the browser console
      console.log("response recorded");
    
    // Check if the response is a string and parse it
    let parsedData;
    if (typeof response.data === 'string') {
      try {
        const cleanedData = response.data.replace(/NaN/g, 'null');
        parsedData = JSON.parse(cleanedData);
      } catch (error) {
        console.error('Failed to parse JSON string:', error);
        return;
      }
    } else {
      parsedData = response.data;
    }

    // Ensure the parsed data is an array
    if (Array.isArray(parsedData)) {
      setCsvData(parsedData);
      setSliceStart(0);
      setSliceEnd(parsedData.length);
    } else {
      console.error('Expected an array but got:', typeof parsedData);
    }
  
    
    } catch (error) {
      console.error('Error fetching data:', error);
    }
  };


  const handleFileUpload = (event) => {
    setFile(event.target.files[0]);
  };

  const handleFileSubmit = () => {
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const csvContent = e.target.result;
        const parsedData = parseCSV(csvContent);
        setCsvData(parsedData);
        setSliceStart(0);
        setSliceEnd(parsedData.length);
      };
      reader.readAsText(file);
    }
  };

  useEffect(() => {
    if (csvData.length > 0) {
      // console.log("csv : ", csvData)
      const slicedData = csvData.slice(sliceStart, sliceEnd);
      // console.log("csv sliced: ", slicedData)
      const plData = calculateProfitLoss(slicedData);
      setProfitLossData(plData);
      // console.log("csv profit loss: ", plData)

      const sortedData = slicedData.sort((a, b) => new Date(a["Activity Date"]) - new Date(b["Activity Date"]));
      let cumulativePL = 0;
      const timeSeriesData = sortedData.map(trade => {
        let amount = 0;
        if (trade.Amount) {
    //console.log("trade amount is ", trade.Amount, typwod )
         if (typeof trade.Amount === 'string') {
           amount = Number(trade.Amount.replace(/[^\d.-]/g, '')); // Convert the string to a number after removing non-numeric characters
           if (trade.Amount.startsWith('(')) {
            amount = -amount;
          }
         } else {
           amount = trade.Amount; // Use the number as it is if it's already a number
         }
          
        }
        cumulativePL += amount;
        return {
          date: trade["Activity Date"],
          pl: cumulativePL
        };
      });
      setTimeSeriesData(timeSeriesData);

      const savedNotes = localStorage.getItem('tradingNotes');
      if (savedNotes) {
        setNotes(savedNotes);
      }
    }
  }, [csvData, sliceStart, sliceEnd]);

  useEffect(() => {
    localStorage.setItem('tradingNotes', notes);
  }, [notes]);

  const slicedData = csvData.slice(sliceStart, sliceEnd);
  const instruments = ['All', ...new Set(slicedData.map(row => row.Instrument))];

  const filteredData = slicedData.filter(row =>
    (selectedInstrument === 'All' || row.Instrument === selectedInstrument) &&
    (dateRange.start === '' || row["Activity Date"] >= dateRange.start) &&
    (dateRange.end === '' || row["Activity Date"] <= dateRange.end)
  );

  const aggregatedPL = profitLossData.reduce((acc, curr) => acc + curr.pl, 0);
  const totalProfit = profitLossData.reduce((acc, curr) => curr.pl > 0 ? acc + curr.pl : acc, 0);
  const totalLoss = profitLossData.reduce((acc, curr) => curr.pl < 0 ? acc - curr.pl : acc, 0);
  const winRate = (profitLossData.filter(trade => trade.pl > 0).length / profitLossData.length) * 100;

  const plByInstrument = profitLossData.reduce((acc, trade) => {
    if (!acc[trade.instrument]) acc[trade.instrument] = 0;
    acc[trade.instrument] += trade.pl;
    return acc;
  }, {});

  const plByRevenue = profitLossData.reduce((acc, trade) => {
    if (!acc[trade.instrument]) acc[trade.instrument] = 0;
    acc[trade.instrument] += trade.revenue;
    return acc;
  }, {});

  const sortedPlByInstrument = Object.entries(plByInstrument)
    .filter(([instrument, pl]) => pl !== 0)
    .map(([instrument, pl]) => ({ instrument, pl }));

  const sortedPlByRevenue = Object.entries(plByRevenue)
    .filter(([instrument, revenue]) => revenue !== 0)
    .map(([instrument, revenue]) => ({ instrument, revenue }));

  const transactionData = slicedData.map(trade => {
    let amount;
    if (typeof trade.Amount === 'string') {
      amount = Number(trade.Amount.replace(/[^\d.-]/g, '')); // Convert the string to a number after removing non-numeric characters
       if (trade.Amount.startsWith('(')) {
        amount = -parseFloat(amount);
      } else {
        amount = parseFloat(amount);
      }
    } else {
      amount = trade.Amount; // Use the number as it is if it's already a number
    }
   
    return {
      label: `${trade["Activity Date"]} - ${trade.Instrument}`,
      date: trade["Activity Date"],
      amount: amount
    };
  });
  const zerofilteredTransactionData = transactionData.filter(transaction => transaction.amount !== 0);

  const topProfitableTrades = profitLossData
    .filter(trade => trade.pl > 0)
    .sort((a, b) => b.pl - a.pl)
    .slice(0, 5);

  const topLossMakingTrades = profitLossData
    .filter(trade => trade.pl < 0)
    .sort((a, b) => a.pl - b.pl)
    .slice(0, 5);

  const plByType = profitLossData.reduce((acc, trade) => {
    if (!acc[trade.type]) acc[trade.type] = 0;
    acc[trade.type] += Math.abs(trade.pl);
    trade.sign = parseInt(trade.pl >= 0);
    return acc;
  }, {});

  Object.keys(plByType).forEach((type) => {
    plByType[type] = {
      pl: plByType[type],
      sign: profitLossData.find((trade) => trade.type === type).pl >= 0 ? 1 : -1,
    };
  });

  const holdingPeriodAnalysis = profitLossData.reduce((acc, trade) => {
    if (!trade || !trade.openDate) return acc;
    if (trade.closeDate <= 0 || trade.openDate <= 0) return acc;

    let holdingPeriod = 0;
    if (trade.expiryDate) {
      holdingPeriod = (trade.expiryDate - trade.openDate) / (1000 * 60 * 60 * 24);
    } else {
      holdingPeriod = (trade.closeDate - trade.openDate) / (1000 * 60 * 60 * 24);
    }

    if (holdingPeriod <= 0) return acc;

    if (trade.pl > 0) {
      acc.profitable.push(holdingPeriod);
    } else {
      acc.unprofitable.push(holdingPeriod);
    }
    return acc;
  }, { profitable: [], unprofitable: [] });

  const avgProfitableHoldingPeriod = holdingPeriodAnalysis.profitable.length > 0
    ? holdingPeriodAnalysis.profitable.reduce((a, b) => a + b, 0) / holdingPeriodAnalysis.profitable.length
    : 0;

  const avgUnprofitableHoldingPeriod = holdingPeriodAnalysis.unprofitable.length > 0
    ? holdingPeriodAnalysis.unprofitable.reduce((a, b) => a + b, 0) / holdingPeriodAnalysis.unprofitable.length
    : 0;


const handleBarClick = (bar) => {
  console.log("Bar clicked:", bar);
  setDisplayPlot(false);
  console.log(bar.activeTooltipIndex)
  // Extract relevant data from the bar
  const clickedBarData = bar.activePayload[0].payload;
  const date =  new Date(clickedBarData.date);
  const amount = clickedBarData.amount;
  const label = clickedBarData.label;
  const ticker = label.split(' - ')[1]; // Assuming the label is in the format "Date - Ticker"

  // Update state or display additional information
  setSelectedTicker(ticker); // Assuming you want to set the ticker based on the date
  // setDisplayAdditionalInfo(true); // Toggle a state to display additional info

  const datespacing = parseInt(datespacingInput) || 10; // Default to 10 days if not provided
  const startStockPlotDate = new Date(date.getTime() - datespacing * 24 * 60 * 60 * 1000);
  const endStockPlotDate = new Date(date.getTime() + datespacing * 24 * 60 * 60 * 1000);
  console.log(startStockPlotDate.toISOString().split('T')[0])
  console.log(endStockPlotDate.toISOString().split('T')[0])
  setStartStockPlotDate(startStockPlotDate.toISOString().split('T')[0]);
  setEndStockPlotDate(endStockPlotDate.toISOString().split('T')[0]);

};

  return (
    <ThemeProvider theme={theme}>
      <div style={{ padding: '1rem' }}>
        <Typography variant="h4" gutterBottom>Options Trading Analysis Dashboard</Typography>

        <div style={{ marginBottom: '1rem' }}>
          <TextField
            type="password"
            label="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            style={{ marginRight: '1rem' }}
          />
          <TextField
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ marginRight: '1rem' }}
          />
          <TextField
            label="Start Date"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            InputLabelProps={{ shrink: true }}
            style={{ marginRight: '1rem' }}
          />
          <TextField
            label="End Date"
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            InputLabelProps={{ shrink: true }}
            style={{ marginRight: '1rem' }}
          />
          <Button variant="contained" color="primary" onClick={handleFetchData}>
            Fetch Data
          </Button>
          <Button
            variant="contained"
            color="primary"
            onClick={() => {
              const clearCache = async () => {
                try {
                  const response = await axios.post('http://localhost:5000/api/clear-cache', {
                    username,
                    password,
                    startDate,
                    endDate,
                  });
                  console.log('Cache cleared and data refetched:', response.data);
                  // Update your state to reflect the new data
                  handleFetchData();
                } catch (error) {
                  console.error('Error clearing cache and refetching data:', error);
                }
              };
              clearCache();
            }}
          >
            Clear Cache
          </Button>
        </div>




        {csvData.length > 0 ? (
          <>
            <div style={{ marginBottom: '1rem' }}>
              <Typography>Start Row: {sliceStart}</Typography>
              <input
                type="range"
                min="0"
                max={csvData.length - 1}
                value={sliceStart}
                onChange={(e) => {
                  const newStart = parseInt(e.target.value);
                  setSliceStart(newStart);
                  if (newStart >= sliceEnd) {
                    setSliceEnd(newStart + 1);
                  }
                }}
              />
              <Typography>End Row: {sliceEnd}</Typography>
              <input
                type="range"
                min={sliceStart + 1}
                max={csvData.length}
                value={sliceEnd}
                onChange={(e) => setSliceEnd(parseInt(e.target.value))}
              />
              <Typography>Showing date range: {csvData[sliceStart] && csvData[sliceStart]["Activity Date"]} to {csvData[sliceEnd - 1] && csvData[sliceEnd - 1]["Activity Date"]}</Typography>
              <Typography>Showing rows {sliceStart} to {sliceEnd} of {csvData.length}</Typography>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '1rem', marginBottom: '1rem' }}>
              <Card>
                <CardHeader title="Total Profit/Loss" />
                <CardContent>
                  <Typography variant="h5" style={{ color: aggregatedPL >= 0 ? 'green' : 'red' }}>
                    ${aggregatedPL.toFixed(2)}
                  </Typography>
                </CardContent>
              </Card>
              <Card>
                <CardHeader title="Total Profit" />
                <CardContent>
                  <Typography variant="h5" style={{ color: 'green' }}>
                    ${totalProfit.toFixed(2)}
                  </Typography>
                </CardContent>
              </Card>
              <Card>
                <CardHeader title="Total Loss" />
                <CardContent>
                  <Typography variant="h5" style={{ color: 'red' }}>
                    ${totalLoss.toFixed(2)}
                  </Typography>
                </CardContent>
              </Card>
              <Card>
                <CardHeader title="Total Trades" />
                <CardContent>
                  <Typography variant="h5">{profitLossData.length}</Typography>
                </CardContent>
              </Card>
              <Card>
                <CardHeader title="Win Rate" />
                <CardContent>
                  <Typography variant="h5">{winRate.toFixed(2)}%</Typography>
                </CardContent>
              </Card>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '2.5fr 1fr', gap: '1rem' }}>
              <Card>
                <CardHeader title="Profit/Loss by Instrument" />
                <CardContent>
                  <Typography variant="body1">Sort by Profit/Loss:</Typography>
                  <Select
                    value={instrumentSort}
                    onChange={(e) => setInstrumentSort(e.target.value)}
                  >
                    <MenuItem value="asc">Ascending</MenuItem>
                    <MenuItem value="desc">Descending</MenuItem>
                    <MenuItem value="none">None</MenuItem>
                  </Select>
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={instrumentSort === 'asc' ? sortedPlByInstrument.sort((a, b) => a.pl - b.pl) :
                      instrumentSort === 'desc' ? sortedPlByInstrument.sort((a, b) => b.pl - a.pl) :
                      sortedPlByInstrument}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="instrument" />
                      <YAxis />
                      <Tooltip />
                      <Legend />
                      <Bar dataKey="pl" fill="#8884d8" />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              <Card>
                <CardHeader title="Profit/Loss by Option Type" />
                <CardContent>
                  <ResponsiveContainer width="100%" height={300}>
                    <PieChart>
                      <Pie
                        data={Object.entries(plByType).map(([type, pl]) => ({ type, pl: pl.pl, sign: pl.sign }))}
                        dataKey="pl"
                        nameKey="type"
                        cx="50%"
                        cy="50%"
                        outerRadius={100}
                        fill="#8884d8"
                        label={(entry) => `${entry.type}: ${entry.sign === 1 ? '+' : '-'}${Math.abs(entry.pl)}`}
                      >
                        {Object.entries(plByType).map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry[0] === 'Call' | entry[0] === 'call' ? '#8884d8' : '#82ca9d'} />
                        ))}
                      </Pie>
                      <Tooltip />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader title="Revenue by Instrument" />
              <CardContent>
                <Typography variant="body1">Sort by Revenue: </Typography>
                <Select
                  value={revenueSort}
                  onChange={(e) => setRevenueSort(e.target.value)}
                >
                  <MenuItem value="asc">Ascending</MenuItem>
                  <MenuItem value="desc">Descending</MenuItem>
                  <MenuItem value="none">None</MenuItem>
                </Select>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={revenueSort === 'asc' ? sortedPlByRevenue.sort((a, b) => a.revenue - b.revenue) :
                    revenueSort === 'desc' ? sortedPlByRevenue.sort((a, b) => b.revenue - a.revenue) :
                    sortedPlByRevenue}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="instrument" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="revenue" fill="#8884d8" />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card style={{ marginTop: '1rem' }}>
              <CardHeader title="Cumulative Profit/Loss Over Time" />
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={timeSeriesData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="pl" stroke="#8884d8" />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card style={{ marginTop: '1rem' }}>
              <CardHeader title="Profit/Loss by Transaction" />
              <CardContent>
                <Typography variant="body1">Sort by Profit/Loss:</Typography>
                <Select
                  value={transactionSort}
                  onChange={(e) => setTransactionSort(e.target.value)}
                >
                  <MenuItem value="asc">Ascending</MenuItem>
                  <MenuItem value="desc">Descending</MenuItem>
                  <MenuItem value="none">None</MenuItem>
                </Select>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={transactionSort === 'asc' ? zerofilteredTransactionData.sort((a, b) => a.amount - b.amount) :
                    transactionSort === 'desc' ? zerofilteredTransactionData.sort((a, b) => b.amount - a.amount) :
                    zerofilteredTransactionData}
                    onClick={(bar) => handleBarClick(bar)} 
                    >
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis />
                    <Tooltip formatter={(value, name, props) => [value, props.payload.label]} />
                    <Legend />
                    <Bar dataKey="amount" fill="#8884d8" />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card style={{ marginTop: '1rem' }}>
            <CardHeader title="Stock Price and Option Transactions" />
            <CardContent>
              <TextField
                label="Stock Ticker"
                value={selectedTicker}
                onChange={(e) => setSelectedTicker(e.target.value)}
                style={{ marginRight: '1rem' }}
              />
              <TextField
                label="Date Spacing (days)"
                value={datespacingInput}
                onChange={(e) => setDatespacingInput(e.target.value)}
                type="number"
                style={{ marginRight: '1rem' }}
              />
              <Button
                variant="contained"
                color="primary"
                onClick={() => {
                  if (selectedTicker && startStockPlotDate && endStockPlotDate) {
                    // Ensure the plot is displayed
                    setDisplayPlot(true);
                  }
                }}
              >
                Display Plot
              </Button>
              {displayPlot && (
                <StockPlot
                  username={username}
                  password={password}
                  ticker={selectedTicker}
                  startDate={startStockPlotDate}
                  endDate={endStockPlotDate}
                />
              )}
            </CardContent>
          </Card>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            {topProfitableTrades.length > 0 && (
              <Card style={{ marginTop: '1rem' }}>
                <CardHeader title="Top Profitable Trades" />
                <CardContent>
                  <table style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        <th>Instrument</th>
                        <th>Type</th>
                        <th>Expiry</th>
                        <th>Strike</th>
                        <th>Profit/Loss</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topProfitableTrades.map((trade, index) => (
                        <tr key={index}>
                          <td>{trade.instrument}</td>
                          <td>{trade.type}</td>
                          <td>{trade.expiry}</td>
                          <td>{trade.strike}</td>
                          <td style={{ color: 'green' }}>${trade.pl.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            )}

            {topLossMakingTrades.length > 0 && (
              <Card style={{ marginTop: '1rem' }}>
                <CardHeader title="Top Loss-Making Trades" />
                <CardContent>
                  <table style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        <th>Instrument</th>
                        <th>Type</th>
                        <th>Expiry</th>
                        <th>Strike</th>
                        <th>Profit/Loss</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topLossMakingTrades.map((trade, index) => (
                        <tr key={index}>
                          <td>{trade.instrument}</td>
                          <td>{trade.type}</td>
                          <td>{trade.expiry}</td>
                          <td>{trade.strike}</td>
                          <td style={{ color: 'red' }}>${trade.pl.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            )}
            </div>

            <TradingNotes />

            <Card style={{ marginTop: '1rem' }}>
              <CardHeader title="All Trades" />
              <CardContent>
                <TableContainer component={Paper} style={{ maxHeight: 400 }}>
                  <Table stickyHeader>
                    <TableHead>
                      <TableRow>
                        <TableCell>Date</TableCell>
                        <TableCell>Instrument</TableCell>
                        <TableCell>Description</TableCell>
                        <TableCell>Transaction</TableCell>
                        <TableCell>Quantity</TableCell>
                        <TableCell>Strike</TableCell>
                        <TableCell>Price</TableCell>
                        <TableCell>Amount</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {filteredData.map((trade, index) => {
                        const parsedDescription = parseDescription(trade.Description);
                        let amount;
                        if (typeof trade.Amount === 'string') {
                          amount = Number(trade.Amount.replace(/[^\d.-]/g, '')); // Convert the string to a number after removing non-numeric characters
                           if (trade.Amount.startsWith('(')) {
                             amount = -parseFloat(amount);
                           } else {
                             amount = parseFloat(amount);
                           }
                        } else {
                          amount = trade.Amount; // Use the number as it is if it's already a number
                        }
                        
                        return (
                          <TableRow key={index}>
                            <TableCell>{trade["Activity Date"]}</TableCell>
                            <TableCell>{trade.Instrument}</TableCell>
                            <TableCell>{trade.Description}</TableCell>
                            <TableCell>{trade["Trans Code"]}</TableCell>
                            <TableCell>{trade.Quantity}</TableCell>
                            <TableCell>${parsedDescription.strike || '0.00'}</TableCell>
                            <TableCell>{trade["Price"]}</TableCell>
                            <TableCell>${amount.toFixed(2)}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TableContainer>
              </CardContent>
            </Card>
          </>
        ) : (
          <Typography>Please upload a CSV file to view the dashboard.</Typography>
        )}
      </div>
    </ThemeProvider>
  );
};

export default OptionsTradingDashboard;