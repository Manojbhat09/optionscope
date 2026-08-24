import React, { useState, useEffect, useMemo, useRef} from 'react';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { Card, CardContent, CardHeader, Select, MenuItem, TextField, Button, Typography, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, CircularProgress } from '@mui/material';
import { LineChart,ScatterChart, Scatter, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell } from 'recharts';
import axios from 'axios';
import { API_BASE } from './apiBase';
import TradingNotes from './tradingnotes'; // Import the TradingNotes component
import StockPlot from './StockPlot';
import PnLCalendar from './components/PnLCalendar';
import ErrorBubble from './components/ErrorBubble';
import { useAssistantContext } from './components/chatbot/assistantContext';
import SettingsCenter from './components/settings/SettingsCenter';
import { getSetting, useSettingsVersion } from './appSettings';
import { LogoIcon, RefreshIcon, SunIcon, MoonIcon, MonitorIcon, GearIcon, ChartUpIcon, BulbIcon } from './components/icons';

// Day/night theming (src/osTheme.js): one builder, two palettes. MUI
// surfaces (Paper/Card/Table/TextField) flip automatically from the palette
// mode; everything else reads the --os-* CSS variables in index.css.
const buildTheme = (mode) => createTheme({
  shape: { borderRadius: 12 },
  typography: {
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    h4: { fontWeight: 800, letterSpacing: '-0.02em' },
    button: { textTransform: 'none', fontWeight: 600 },
  },
  palette: {
    mode,
    ...(mode === 'dark' ? {
      primary: { main: '#64b5f6' },
      background: { default: 'transparent', paper: '#151b2c' },
      divider: '#263048',
      success: { main: '#4caf7d' }, warning: { main: '#e0a458' }, error: { main: '#ef6b6b' },
    } : {}),
  },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          border: '1px solid var(--os-border)',
          boxShadow: 'var(--os-shadow-1)',
        },
      },
    },
    MuiCard: { styleOverrides: { root: { border: '1px solid var(--os-border)', boxShadow: 'var(--os-shadow-1)' } } },
    MuiButton: { defaultProps: { disableElevation: true }, styleOverrides: { root: { borderRadius: 10 } } },
    MuiTextField: { defaultProps: { size: 'small' } },
    MuiTableCell: { styleOverrides: { root: { borderColor: 'var(--os-border)' } } },
  },
});

// Consistent money formatting across the dashboard — thousands separators
// and "-$1,234.00" sign placement instead of "$-1234.00".
// Honors Settings → Preferences: P/L decimal places + compact thousands.
function fmtMoney(n) {
  if (n === null || n === undefined || isNaN(n)) return '$0.00';
  const dpRaw = parseInt(localStorage.getItem('pl_decimals'), 10);
  const dp = Number.isFinite(dpRaw) ? Math.min(2, Math.max(0, dpRaw)) : 2;
  if (localStorage.getItem('compact_numbers') === 'true' && Math.abs(n) >= 1000) {
    return (n < 0 ? '-$' : '$') + (Math.abs(n) / 1000).toFixed(1) + 'k';
  }
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return (n < 0 ? '-$' : '$') + abs;
}

// Compact variant for chart axis ticks — fixed-width labels ("-$10k") don't
// have room for fmtMoney's full "-$10,000.00", and Recharts right-anchors
// axis text, so an overflowing label clips off its own leading characters
// (a "-$10,000.00" tick was rendering as "0,000.00" before this existed).
function fmtCompact(n) {
  if (n === null || n === undefined || isNaN(n)) return '$0';
  const abs = Math.abs(n);
  const scaled = abs >= 1000 ? (abs / 1000).toFixed(1) + 'k' : abs.toFixed(0);
  return (n < 0 ? '-$' : '$') + scaled;
}

// eslint-disable-next-line no-unused-vars
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
  let instrument, desc = '', expiry, type, strike; // eslint-disable-line no-unused-vars

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

  return { instrument, expiry, type, strike };
}

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
        openDateTime: null,
        closeDateTime: null,
        expiryDate: null,
        sign: 1,
        revenue: 0,
        gainRatio: null
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
        profitLoss[key].openDateTime = trade["Activity DateTime"] || null;
      }
    } else if (trade["Trans Code"] === "STC") {
      profitLoss[key].sellQuantity += quantity;
      profitLoss[key].sellAmount += totalCost;
      profitLoss[key].revenue = profitLoss[key].sellAmount; // Update revenue for STC trades
      if (!profitLoss[key].closeDate || date > profitLoss[key].closeDate) {
        profitLoss[key].closeDate = date;
        profitLoss[key].closeDateTime = trade["Activity DateTime"] || null;
      }
      // Calculate gainRatio
      if (profitLoss[key].buyAmount > 0) {
        profitLoss[key].gainRatio = (profitLoss[key].sellAmount / profitLoss[key].buyAmount);
      }
    }

    if (trade["Trans Code"] === "OEXP" || trade.Description.toLowerCase().includes("exp")) {
      profitLoss[key].sellAmount = 0;
      profitLoss[key].sellQuantity = profitLoss[key].buyQuantity;
      // profitLoss[key].pl = profitLoss[key].sellAmount - profitLoss[key].buyAmount;
      profitLoss[key].pl = -profitLoss[key].buyAmount; // Update P/L for expired trades
      profitLoss[key].revenue = 0; // Set revenue to 0 for expired trades
      profitLoss[key].expiryDate = new Date(trade["Process Date"]);

      if (profitLoss[key].buyAmount > 0) {
        profitLoss[key].gainRatio = (profitLoss[key].sellAmount / profitLoss[key].buyAmount);
      } else {
        profitLoss[key].gainRatio = null; // Or handle it as per your requirement
      }
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

// [1] ERROR: There was an issue loading pickle file. Authentication may be expired - logging in normally.
// Enter Robinhood code for validation:

// [1] ERROR: There was an issue loading pickle file. Authentication may be expired - logging in normally.
// Please type in the MFA code: 485740

// >>> import robin_stocks.robinhood as rh
// >>> rh.login(username="", password="")
// ERROR: There was an issue loading pickle file. Authentication may be expired - logging in normally.
// Please type in the MFA code: 136493

// for searching any text, use the browser search 

const OptionsTradingDashboard = ({ onReplayTrade, onDatesChange, chatOpen, registry, osTheme }) => {
  const dashboardRef = useRef(null);
  const [csvData, setCsvData] = useState([]);
  const [profitLossData, setProfitLossData] = useState([]);
  const [username, setUsername] = useState(() => localStorage.getItem('dash_user') || '');
  const [password, setPassword] = useState(() => localStorage.getItem('dash_pass') || '');
  const [showSetup, setShowSetup] = useState(false); // Settings Center modal
  const mode = osTheme?.mode || 'light';
  const muiTheme = useMemo(() => buildTheme(mode), [mode]);
  // Settings → Preferences → default lookback: "last N days" from today
  // instead of the fixed 2023-01-01 start (0 keeps the old behavior).
  const [startDate, setStartDate] = useState(() => {
    const lb = parseInt(localStorage.getItem('default_lookback_days'), 10) || 0;
    return lb > 0 ? new Date(Date.now() - lb * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) : '2023-01-01';
  });
  const [endDate, setEndDate] = useState(new Date().toISOString().slice(0, 10));
  const [instrumentSort, setInstrumentSort] = useState('none');
  const [revenueSort, setRevenueSort] = useState('none');
  const [transactionSort, setTransactionSort] = useState('none');
  const [selectedInstrument, setSelectedInstrument] = useState('All'); // eslint-disable-line no-unused-vars
  const [dateRange, setDateRange] = useState({ start: '', end: '' }); // eslint-disable-line no-unused-vars
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
  const [topLimit, setTopLimit] = useState(() =>
    parseInt(localStorage.getItem('dash_top_limit'), 10) || 100); // how many top win/loss rows the tables list
  useSettingsVersion(); // re-render when Preferences change (number formats)
  const [gainRatioData, setGainRatioData] = useState([]);
  const [isFetching, setIsFetching] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const [showRowRange, setShowRowRange] = useState(false); // row-index slicer is a power-user tool, collapsed by default

  // ── preferences-driven behaviors (Settings → Preferences) ──────────────────
  const autoLoadRef = useRef(false);
  useEffect(() => {
    if (getSetting('remember_filters')) localStorage.setItem('dash_top_limit', String(topLimit));
  }, [topLimit]);

  // Auto-load trades on launch when a login is saved — the backend serves the
  // cached order history, so this is usually instant.
  useEffect(() => {
    if (autoLoadRef.current) return;
    autoLoadRef.current = true;
    if (getSetting('auto_load_trades') && username && password && csvData.length === 0) {
      handleFetchData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    setIsFetching(true);
    setFetchError('');
    try {
      const response = await axios.post(`${API_BASE}/api/fetch-data`, {
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
        setFetchError('The server returned data that could not be parsed. Check the backend logs.');
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
      // Settings → Preferences → remember login: persist only after a
      // successful fetch so bad credentials never get cached.
      if (getSetting('rh_persist')) {
        localStorage.setItem('dash_user', username);
        localStorage.setItem('dash_pass', password);
      }
    } else {
      console.error('Expected an array but got:', typeof parsedData);
      setFetchError('The server returned an unexpected response shape — expected a list of trades.');
    }
  
    
    } catch (error) {
      console.error('Error fetching data:', error);
      setFetchError(error?.response?.data?.error || error.message || 'Fetch failed');
    } finally {
      setIsFetching(false);
    }
  };

  // ── single control point: click a period in the P&L grid → scope the whole
  // dashboard to it. Syncs the top Start/End Date pickers and the row-range
  // slider, so every derived view (stats, charts, All Trades table) re-renders
  // against just that period — no refetch needed, csvData already covers it.
  const handlePeriodSelect = (start, end) => {
    setStartDate(start);
    setEndDate(end);

    const matches = [];
    csvData.forEach((row, i) => {
      const d = row['Activity Date'];
      if (d && d >= start && d <= end) matches.push(i);
    });
    if (matches.length) {
      setSliceStart(Math.min(...matches));
      setSliceEnd(Math.max(...matches) + 1);
    }
  };

  // eslint-disable-next-line no-unused-vars
  const handleFileUpload = (event) => {
    setFile(event.target.files[0]);
  };

  // eslint-disable-next-line no-unused-vars
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

  // Notify parent whenever dates change so Trade Replay can pre-fill them
  useEffect(() => {
    if (onDatesChange) onDatesChange({ startDate, endDate });
  }, [startDate, endDate]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (csvData.length > 0) {
      const slicedData = csvData.slice(sliceStart, sliceEnd);

      // P&L must be netted (BTO vs STC/OEXP) across the FULL trade history
      // first, then filtered down to the selected window by position — never
      // by pre-slicing rows. A position whose open and close legs straddle
      // the window boundary (e.g. opened the last day of the month, closed
      // two days later) would otherwise have its closing leg silently
      // excluded, scoring a real profitable trade as a full loss.
      const rangeStartDate = slicedData[0] ? new Date(slicedData[0]["Activity Date"]) : null;
      const rangeEndDate   = slicedData[slicedData.length - 1] ? new Date(slicedData[slicedData.length - 1]["Activity Date"]) : null;
      const allPlData = calculateProfitLoss(csvData);
      const plData = (rangeStartDate && rangeEndDate)
        ? allPlData.filter(p => p.openDate && p.openDate >= rangeStartDate && p.openDate <= rangeEndDate)
        : allPlData;
      setProfitLossData(plData);
      const gainRatioDataDates = plData.filter(trade => trade.gainRatio !== null)
        .reduce((acc, trade) => {
          const selectDate = trade.closeDate ? trade.closeDate : trade.expiryDate;
          const date = new Date(selectDate).toLocaleDateString()
          if (!acc[date]) {
            acc[date] = [];
          }
          acc[date].push({
            date: trade.closeDate,
            gainRatio: trade.gainRatio,
            ticker: trade.instrument,
            optionDetails: `${trade.type} ${trade.expiry} ${trade.strike}`,
          });
          return acc;
        }, {});

        let gainRatioData;
        if (gainRatioDataDates) {
            gainRatioData = Object.entries(gainRatioDataDates)
              .map(([date, trades]) => ({
                date: date,
                trades: trades,
              }))
              .sort((a, b) => a.date - b.date);
          } else {
            console.log("error in getting the gainratiodate right")
            console.log(gainRatioDataDates)
            gainRatioData = []; // Default to an empty array if gainRatioData is undefined
          }

      console.log(gainRatioData)
      setGainRatioData(gainRatioData);

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
  const instruments = ['All', ...new Set(slicedData.map(row => row.Instrument))]; // eslint-disable-line no-unused-vars

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

  // Full sorted win/loss lists — the tables slice these to `topLimit` rows
  // (scrollable); the assistant context keeps its own concise top-5 slice.
  const sortedProfitableTrades = profitLossData
    .filter(trade => trade.pl > 0)
    .sort((a, b) => b.pl - a.pl);
  const sortedLossMakingTrades = profitLossData
    .filter(trade => trade.pl < 0)
    .sort((a, b) => a.pl - b.pl);

  const topProfitableTrades = sortedProfitableTrades.slice(0, topLimit);
  const topLossMakingTrades = sortedLossMakingTrades.slice(0, topLimit);

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

  // eslint-disable-next-line no-unused-vars
  const avgProfitableHoldingPeriod = holdingPeriodAnalysis.profitable.length > 0
    ? holdingPeriodAnalysis.profitable.reduce((a, b) => a + b, 0) / holdingPeriodAnalysis.profitable.length
    : 0;

  // eslint-disable-next-line no-unused-vars
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
  const amount = clickedBarData.amount; // eslint-disable-line no-unused-vars
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


const scatterData = gainRatioData.flatMap(trade => trade.trades.map((t, index) => ({
  date: trade.date, // Convert date to timestamp for plotting
  gainRatio: t.gainRatio,
  ticker: t.ticker,
  optionDetails: t.optionDetails,
  id: `${new Date(trade.date).toISOString()}${index}`, // Unique ID for each trade
})));
console.log(scatterData)

// eslint-disable-next-line no-unused-vars
const CustomTooltip = ({ active, payload }) => {
  if (!active || !payload) return null;

  console.log(active, payload);
  let trade;
  let datepayload; // eslint-disable-line no-unused-vars
  datepayload = payload[0];
  trade = payload[1];

return (
    <div className="tooltip-content">
      <ul>
      <li key={trade.payload.id}>
            <p>Close-Date: {new Date(trade.payload.date).toLocaleDateString()} {new Date(trade.payload.date).toUTCString()}</p>
            <p>{trade.payload.ticker} - {trade.payload.optionDetails}</p>
            <p>Gain-Ratio: {trade.value}</p>
          </li>
        
      </ul>
    </div>
  );
};

  // ── structured context for the chat assistant ──────────────────────────────
  // Built fresh on every call (not memoized) so it always reflects whatever's
  // currently on screen — the row range, date filters, and computed P&L. A
  // screenshot alone makes the assistant guess numbers from pixels; this gives
  // it the real, exact figures to reason about instead — including the exact
  // buy/sell timestamps, contract quantities, and premiums that aren't
  // legible from a chart screenshot at all.
  const ALL_TRADES_CONTEXT_CAP = 300; // keeps the JSON payload bounded for large date ranges

  const getChatContext = () => {    const heldHours = (t) => {
      if (!t.openDateTime || !t.closeDateTime) return null;
      const ms = new Date(t.closeDateTime) - new Date(t.openDateTime);
      return ms > 0 ? +(ms / 3600000).toFixed(1) : null;
    };

    const tradeSummary = (t) => ({
      instrument: t.instrument, type: t.type, strike: t.strike, expiry: t.expiry,
      buyQuantity: t.buyQuantity, sellQuantity: t.sellQuantity,
      premiumPaid: Math.round(t.buyAmount), premiumReceived: Math.round(t.sellAmount),
      pl: Math.round(t.pl),
      gainRatio: t.gainRatio != null ? +t.gainRatio.toFixed(2) : null,
      // Full ISO UTC timestamp when available (exact buy/sell time), falling
      // back to date-only for legs where the raw timestamp wasn't captured.
      openDateTime: t.openDateTime || (t.openDate ? new Date(t.openDate).toISOString().slice(0, 10) : null),
      closeDateTime: t.closeDateTime || (t.closeDate ? new Date(t.closeDate).toISOString().slice(0, 10) : null),
      heldHours: heldHours(t),
    });

    const chronological = [...profitLossData].sort((a, b) => {
      const av = a.openDateTime || a.openDate || '';
      const bv = b.openDateTime || b.openDate || '';
      return av < bv ? -1 : av > bv ? 1 : 0;
    });
    const truncated = chronological.length > ALL_TRADES_CONTEXT_CAP;
    // Keep the most recent trades when truncating — usually what "in this
    // period" questions care about most once a range is already narrowed.
    const allTrades = (truncated ? chronological.slice(-ALL_TRADES_CONTEXT_CAP) : chronological).map(tradeSummary);

    return {
      dateRangeFilter: { start: startDate, end: endDate },
      rowRange: { start: sliceStart, end: sliceEnd, totalRowsAvailable: csvData.length },
      note: "All amounts are USD. Standard US equity option contracts represent 100 shares each "
          + "(Amount ≈ Price × Quantity × 100) — buyQuantity/sellQuantity below are contract counts, "
          + "not shares. openDateTime/closeDateTime are exact timestamps (UTC) when available; "
          + "heldHours is the exact time between them.",
      summary: {
        totalPL: Math.round(aggregatedPL),
        totalProfit: Math.round(totalProfit),
        totalLoss: Math.round(totalLoss),
        totalTrades: profitLossData.length,
        winRatePct: profitLossData.length ? +winRate.toFixed(1) : null,
      },
      plByInstrument: sortedPlByInstrument
        .slice().sort((a, b) => Math.abs(b.pl) - Math.abs(a.pl)).slice(0, 15)
        .map(i => ({ instrument: i.instrument, pl: Math.round(i.pl) })),
      plByOptionType: Object.entries(plByType).map(([type, v]) => ({
        type, pl: v.sign === 1 ? Math.round(v.pl) : -Math.round(v.pl),
      })),
      topProfitableTrades: sortedProfitableTrades.slice(0, 5).map(tradeSummary),
      topLossMakingTrades: sortedLossMakingTrades.slice(0, 5).map(tradeSummary),
      // The complete trade list for the current view (not just the top 5
      // win/loss highlights above) — capped and clearly labeled if truncated,
      // so the assistant never mistakes a partial list for the full ledger.
      allTrades,
      allTradesTruncated: truncated,
      allTradesTotalCount: profitLossData.length,
    };
  };

  // The assistant reads THIS page's context + screenshot whenever the
  // dashboard is the visible page (see files/assistant-history-design.md).
  useAssistantContext(registry, {
    id: 'dashboard',
    title: 'Dashboard',
    getContext: getChatContext,
    targetRef: dashboardRef,
  });

  return (
    <ThemeProvider theme={muiTheme}>
      <div ref={dashboardRef} style={{ padding: '1rem 1.5rem', background: 'var(--os-bg)', minHeight: '100vh' }} className={`analysis-space ${chatOpen ? 'open' : ''}`} >
        {/* ── sticky translucent top bar (2026 pattern: glass only on
               overlays/sticky chrome; solid surfaces everywhere else) ── */}
        <div style={{
          position: 'sticky', top: 0, zIndex: 900, margin: '-1rem -1.5rem 1rem',
          padding: '10px 1.5rem', display: 'flex', alignItems: 'center', gap: 12,
          background: 'var(--os-surface-glass)', backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)', borderBottom: '1px solid var(--os-border)',
          transition: 'background .25s ease, border-color .25s ease',
        }}>
          <Typography variant="h4" style={{ fontSize: 19, fontWeight: 800, color: 'var(--os-text)', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 8 }}>
            <LogoIcon size={20} /> OptionScope
          </Typography>
          <span style={{
            fontSize: 11.5, fontWeight: 600, padding: '3px 10px', borderRadius: 999,
            background: profitLossData.length ? 'rgba(76,175,125,.14)' : 'rgba(224,164,88,.16)',
            color: profitLossData.length ? '#4caf7d' : '#e0a458',
            whiteSpace: 'nowrap',
          }}>
            {profitLossData.length ? `Connected · ${profitLossData.length} trades` : 'Not connected'}
          </span>
          <div style={{ flex: 1 }} />
          <TextField label="Start" type="date" size="small" value={startDate}
                     onChange={(e) => setStartDate(e.target.value)} InputLabelProps={{ shrink: true }}
                     style={{ width: 150 }} />
          <TextField label="End" type="date" size="small" value={endDate}
                     onChange={(e) => setEndDate(e.target.value)} InputLabelProps={{ shrink: true }}
                     style={{ width: 150 }} />
          <Button variant="contained" color="primary" onClick={handleFetchData}
                  disabled={isFetching} className="os-btn-lift">
            {isFetching ? 'Fetching…' : 'Fetch Data'}
          </Button>
          <Button variant="outlined" color="inherit" size="small" onClick={() => {
              const clearCache = async () => {
                try {
                  await axios.post(`${API_BASE}/api/clear-cache`, { username, password, startDate, endDate });
                  handleFetchData();
                } catch (error) {
                  console.error('Error clearing cache and refetching data:', error);
                  setFetchError(error?.response?.data?.error || error.message || 'Failed to clear cache');
                }
              };
              clearCache();
            }}
            title="Delete cached order history and re-fetch from Robinhood"
            style={{ borderColor: '#e3e8f0', color: '#98a2b3', minWidth: 0, padding: '5px 10px' }}>
            <RefreshIcon size={16} />
          </Button>
          <Button variant="outlined" color="inherit" onClick={() => osTheme?.toggle()}
                  title={osTheme?.saved === 'auto'
                    ? 'Theme: Auto (night 19:00–07:00) — click for Day'
                    : osTheme?.saved === 'dark'
                      ? 'Theme: Night — click for Auto'
                      : 'Theme: Day — click for Night'}
                  aria-label="Cycle day/night/auto theme"
                  style={{ borderColor: 'var(--os-border)', color: 'var(--os-text-2)', minWidth: 0, padding: '5px 11px' }}>
            {osTheme?.saved === 'auto'
              ? <MonitorIcon size={16} />
              : mode === 'dark' ? <SunIcon size={16} /> : <MoonIcon size={16} />}
          </Button>
          <Button variant="outlined" color="inherit" onClick={() => setShowSetup(true)} className="os-btn-lift"
                  title="Credentials, AI keys & preferences"
                  style={{ borderColor: 'var(--os-border)', color: 'var(--os-text-2)', fontWeight: 700 }}>
            <GearIcon size={15} /> Setup
          </Button>
        </div>

        <SettingsCenter
          open={showSetup}
          onClose={() => setShowSetup(false)}
          osTheme={osTheme}
          credentials={{ username, password, startDate, endDate }}
          onSaveCredentials={({ username: u, password: p, startDate: s, endDate: e }) => {
            setUsername(u); setPassword(p);
            if (s) setStartDate(s);
            if (e) setEndDate(e);
            localStorage.setItem('dash_user', u || '');
            localStorage.setItem('dash_pass', p || '');
          }}
        />


        {isFetching ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '1rem 0' }}>
            <CircularProgress size={20} />
            <Typography>
              Fetching options history from Robinhood — large accounts (thousands of orders)
              can take a minute or more on the first fetch…
            </Typography>
          </div>
        ) : csvData.length > 0 ? (
          <>
            <div style={{ marginBottom: '0.75rem' }}>
              <button
                onClick={() => setShowRowRange(s => !s)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  color: '#5c6b8a', fontSize: 13, display: 'flex', alignItems: 'center', gap: 4,
                }}
              >
                {showRowRange ? '▾' : '▸'} Advanced: filter by row range
                <span style={{ color: '#9aa5bd', fontWeight: 400 }}>
                  ({sliceStart}–{sliceEnd} of {csvData.length}{(sliceStart > 0 || sliceEnd < csvData.length) ? ' · narrowed' : ''})
                </span>
              </button>

              {showRowRange && (
                <div style={{
                  marginTop: 8, padding: '0.75rem 1rem', background: '#fff',
                  border: '1px solid #e2e6ee', borderRadius: 8, maxWidth: 480,
                }}>
                  <Typography variant="caption" style={{ color: '#888' }}>Start Row: {sliceStart}</Typography>
                  <input
                    style={{ width: '100%' }}
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
                  <Typography variant="caption" style={{ color: '#888' }}>End Row: {sliceEnd}</Typography>
                  <input
                    style={{ width: '100%' }}
                    type="range"
                    min={sliceStart + 1}
                    max={csvData.length}
                    value={sliceEnd}
                    onChange={(e) => setSliceEnd(parseInt(e.target.value))}
                  />
                  <Typography variant="caption" style={{ display: 'block', color: '#888', marginTop: 4 }}>
                    {csvData[sliceStart] && csvData[sliceStart]["Activity Date"]} → {csvData[sliceEnd - 1] && csvData[sliceEnd - 1]["Activity Date"]}
                  </Typography>
                  {(sliceStart > 0 || sliceEnd < csvData.length) && (
                    <Button size="small" onClick={() => { setSliceStart(0); setSliceEnd(csvData.length); }} style={{ marginTop: 4 }}>
                      Reset to full range
                    </Button>
                  )}
                </div>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '0.75rem', marginBottom: '1rem' }}>
              {[
                { label: 'Total Profit/Loss', value: fmtMoney(aggregatedPL), color: aggregatedPL >= 0 ? '#00a844' : '#e53935', accent: aggregatedPL >= 0 ? '#00a844' : '#e53935' },
                { label: 'Total Profit',      value: fmtMoney(totalProfit), color: '#00a844', accent: '#00a844' },
                { label: 'Total Loss',        value: fmtMoney(-totalLoss),  color: '#e53935', accent: '#e53935' },
                { label: 'Total Trades',      value: profitLossData.length, color: 'var(--os-text)', accent: '#90a4ae' },
                { label: 'Win Rate',          value: `${winRate.toFixed(2)}%`, color: winRate >= 50 ? '#00a844' : '#e53935', accent: winRate >= 50 ? '#00a844' : '#e53935' },
              ].map(stat => (
                <Card key={stat.label} elevation={0} style={{
                  borderRadius: 10, border: '1px solid var(--os-border)',
                  borderLeft: `4px solid ${stat.accent}`,
                }}>
                  <CardContent style={{ padding: '0.85rem 1.1rem' }}>
                    <Typography variant="caption" style={{ color: 'var(--os-text-3)', textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 600 }}>
                      {stat.label}
                    </Typography>
                    <Typography variant="h5" style={{ color: stat.color, fontWeight: 700, marginTop: 2 }}>
                      {stat.value}
                    </Typography>
                  </CardContent>
                </Card>
              ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '2.5fr 1fr', gap: '0.5rem' }}>
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
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={instrumentSort === 'asc' ? sortedPlByInstrument.sort((a, b) => a.pl - b.pl) :
                      instrumentSort === 'desc' ? sortedPlByInstrument.sort((a, b) => b.pl - a.pl) :
                      sortedPlByInstrument}
                      margin={{ bottom: 30, left: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="instrument" angle={-45} textAnchor="end" interval={0} height={50}
                        tick={{ fontSize: 10 }} />
                      <YAxis tickFormatter={v => fmtCompact(v)} width={68} />
                      <Tooltip formatter={v => fmtMoney(v)} />
                      <Bar dataKey="pl" name="P&L">
                        {(instrumentSort === 'asc' ? sortedPlByInstrument.sort((a, b) => a.pl - b.pl) :
                          instrumentSort === 'desc' ? sortedPlByInstrument.sort((a, b) => b.pl - a.pl) :
                          sortedPlByInstrument).map((entry, i) => (
                          <Cell key={i} fill={entry.pl >= 0 ? '#00c853' : '#e53935'} fillOpacity={0.85} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              <Card>
                <CardHeader title="Profit/Loss by Option Type" />
                <CardContent>
                  <ResponsiveContainer width="100%" height={260}>
                    <PieChart margin={{ top: 20, right: 30, bottom: 20, left: 30 }}>
                      <Pie
                        data={Object.entries(plByType).map(([type, pl]) => ({ type, pl: pl.pl, sign: pl.sign }))}
                        dataKey="pl"
                        nameKey="type"
                        cx="50%"
                        cy="50%"
                        outerRadius={60}
                        fill="#8884d8"
                        labelLine={{ stroke: '#bbb', strokeWidth: 1 }}
                        label={(entry) => `${entry.type}: ${fmtMoney(entry.sign === 1 ? entry.pl : -entry.pl)}`}
                      >
                        {Object.entries(plByType).map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry[0].toLowerCase() === 'call' ? '#8884d8' : '#82ca9d'} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v, n, p) => [fmtMoney(p.payload.sign === 1 ? p.payload.pl : -p.payload.pl), p.payload.type]} />
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
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={revenueSort === 'asc' ? sortedPlByRevenue.sort((a, b) => a.revenue - b.revenue) :
                    revenueSort === 'desc' ? sortedPlByRevenue.sort((a, b) => b.revenue - a.revenue) :
                    sortedPlByRevenue}
                    margin={{ bottom: 30, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="instrument" angle={-45} textAnchor="end" interval={0} height={50}
                      tick={{ fontSize: 10 }} />
                    <YAxis tickFormatter={v => fmtCompact(v)} width={68} />
                    <Tooltip formatter={v => fmtMoney(v)} />
                    <Legend />
                    <Bar dataKey="revenue" fill="#8884d8" />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            

            <Card style={{ marginTop: '0.5rem' }}>
              <CardHeader title="Cumulative Profit/Loss Over Time" />
              <CardContent>
                <ResponsiveContainer width="100%" height={200}>
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


          <Card style={{ marginTop: '0.5rem' }}>
          <CardHeader title="Gain Ratio (Buy/Sell price) Over Time" />
          <CardContent>
            {onReplayTrade && (
              <p style={{ fontSize: 12, color: '#1976d2', margin: '0 0 8px',
                         background: '#e3f2fd', padding: '6px 10px', borderRadius: 6 }}>
                <BulbIcon size={13} /> Click any dot to open Trade Replay for that ticker
              </p>
            )}
            <ResponsiveContainer width="100%" height={200}>
              <ScatterChart data={scatterData}
                onClick={(e) => {
                  if (!onReplayTrade || !e?.activePayload?.[0]) return;
                  const d = e.activePayload[0].payload;
                  onReplayTrade({ ticker: d.ticker || 'All', minGR: 0, startDate, endDate });
                }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0].payload;
                  return (
                    <div style={{ background:'rgba(20,20,20,.88)', color:'#fff',
                      padding:'8px 12px', borderRadius:6, fontSize:12, lineHeight:1.7 }}>
                      <strong>Close-Date: {d.date}</strong><br />
                      {d.ticker} - {d.optionDetails}<br />
                      Gain-Ratio: {d.gainRatio}<br />
                      {onReplayTrade && <span style={{ color:'#90caf9' }}>Click to replay →</span>}
                    </div>
                  );
                }} />
                <Legend />
                <Scatter data={scatterData} dataKey="gainRatio" type="number" fill="#82ca9d"
                  style={{ cursor: onReplayTrade ? 'pointer' : 'default' }} />
              </ScatterChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

            <Card style={{ marginTop: '0.5rem' }}>
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
                <ResponsiveContainer width="100%" height={200}>
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

            <Card style={{ marginTop: '0.5rem' }}>
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
                  if (!selectedTicker) return;
                  // Dates default to a window around the most recent loaded
                  // transaction (or today) — clicking a bar in the P/L chart
                  // above still refines them to that bar's date.
                  if (!startStockPlotDate || !endStockPlotDate) {
                    const ds = parseInt(datespacingInput) || 10;
                    const raw = csvData.length ? csvData[csvData.length - 1]["Activity Date"] : null;
                    let base = raw ? new Date(raw) : new Date();
                    if (isNaN(base.getTime())) base = new Date();
                    setStartStockPlotDate(new Date(base.getTime() - ds * 24 * 60 * 60 * 1000).toISOString().split('T')[0]);
                    setEndStockPlotDate(new Date(base.getTime() + ds * 24 * 60 * 60 * 1000).toISOString().split('T')[0]);
                  }
                  setDisplayPlot(true);
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

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
            {topProfitableTrades.length > 0 && (
              <Card style={{ marginTop: '0.5rem' }}>
                <CardHeader
                  title="Top Profitable Trades"
                  action={
                    <TextField
                      size="small" variant="outlined" type="number" label="Limit"
                      value={topLimit} min={1}
                      onChange={(e) => setTopLimit(Math.max(1, parseInt(e.target.value, 10) || 1))}
                      style={{ width: 90, marginTop: -6 }} inputProps={{ style: { fontSize: 13 } }}
                    />
                  }
                />
                <CardContent>
                  <div style={{ overflowY: 'auto', maxHeight: 240 }}>
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
                  </div>
                </CardContent>
              </Card>
            )}

            {topLossMakingTrades.length > 0 && (
              <Card style={{ marginTop: '0.5rem' }}>
                <CardHeader
                  title="Top Loss-Making Trades"
                  action={
                    <TextField
                      size="small" variant="outlined" type="number" label="Limit"
                      value={topLimit} min={1}
                      onChange={(e) => setTopLimit(Math.max(1, parseInt(e.target.value, 10) || 1))}
                      style={{ width: 90, marginTop: -6 }} inputProps={{ style: { fontSize: 13 } }}
                    />
                  }
                />
                <CardContent>
                  <div style={{ overflowY: 'auto', maxHeight: 240 }}>
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
                  </div>
                </CardContent>
              </Card>
            )}
            </div>

            <PnLCalendar trades={slicedData} onPeriodSelect={handlePeriodSelect} />

            <TradingNotes />

            <Card style={{ marginTop: '0.5rem' }}>
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
          /* Onboarding empty state (2026 pattern: empty states are quests,
             not dead ends — one clear next action) */
          <Paper elevation={0} style={{ padding: '48px 32px', textAlign: 'center', borderRadius: 16 }}>
            <div style={{ marginBottom: 10, color: '#4c7daf' }}><ChartUpIcon size={44} /></div>
            <Typography style={{ fontSize: 18, fontWeight: 700, color: 'var(--os-text)', marginBottom: 6 }}>
              Bring your options history to life
            </Typography>
            <Typography style={{ fontSize: 13.5, color: 'var(--os-text-2)', maxWidth: 460, margin: '0 auto 22px', lineHeight: 1.6 }}>
              1 · Add your Robinhood credentials in Setup &nbsp;·&nbsp;
              2 · Pick a date range above &nbsp;·&nbsp; 3 · Hit <b>Fetch Data</b>.
              Then ask the assistant anything about your trades — or open Spot Replay.
            </Typography>
            <Button variant="contained" color="primary" onClick={() => setShowSetup(true)} className="os-btn-lift">
              <GearIcon size={15} /> Open Setup
            </Button>
            <div style={{ marginTop: 14, fontSize: 11.5, color: 'var(--os-text-3)' }}>
              Credentials never leave this browser except to your locally-running backend.
            </div>
          </Paper>
        )}
      </div>
    </ThemeProvider>
  );
};

export default OptionsTradingDashboard;
