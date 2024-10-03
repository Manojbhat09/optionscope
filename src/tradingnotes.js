import React, { useState, useEffect } from 'react';
import { Card, CardHeader, CardContent, TextField, Button } from '@mui/material';
import ReactMarkdown from 'react-markdown';


const defaultNotes = `# Trading Notes

## Upload your trading data:
- Use the file upload feature to import your CSV file containing your trading history.
- Once uploaded, the dashboard will process your data and display various analytics.

## Analyze Profit/Loss by Option Type:
- Look at the "Profit/Loss by Option Type" pie chart. This will show you the overall performance of your call and put options.
- If one type (calls or puts) is significantly outperforming the other, you might want to focus more on the successful type.

## Examine Top Profitable and Loss-Making Trades:
- The dashboard displays tables for "Top Profitable Trades" and "Top Loss-Making Trades".
- Pay attention to the patterns in these tables. Look for common characteristics among your profitable trades (e.g., specific instruments, expiry dates, or strike prices) and try to avoid patterns seen in loss-making trades.

## Analyze Profit/Loss by Instrument:
- The "Profit/Loss by Instrument" bar chart shows how different underlying assets have performed.
- Identify which instruments have been most profitable for you and consider focusing more on these.

## Study the Cumulative Profit/Loss Over Time:
- This line chart shows your overall performance trend.
- Look for periods of consistent gains and analyze what strategies you were using during those times.

## Examine the Holding Period Analysis:
- This chart shows how long you typically hold your positions.
- Compare the average holding periods for profitable vs. unprofitable trades. This might reveal if you're closing profitable positions too early or holding onto losing positions for too long.

## Review All Trades:
- The "All Trades" table at the bottom provides a detailed view of each transaction.
- Look for patterns in your successful trades, such as specific days of the week, times of day, or market conditions when you entered the trades.

## To avoid repeating mistakes:
1. Set strict loss limits and stick to them.
2. Diversify your trades across different instruments to spread risk.
3. Pay attention to position sizing - avoid putting too much capital into a single trade.
4. Use the dashboard regularly to keep track of your performance and adjust your strategy as needed.`


const TradingNotes = () => {
  const [notes, setNotes] = useState('');
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    const savedNotes = localStorage.getItem('tradingNotes');
    if (savedNotes) {
      setNotes(savedNotes);
    } else {
      setNotes(defaultNotes);
    }
  }, []);

  const handleSave = () => {
    localStorage.setItem('tradingNotes', notes);
    setIsEditing(false);
  };

  const handleExport = () => {
    const blob = new Blob([notes], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'trading_notes.md';
    link.click();
    URL.revokeObjectURL(url);
  };


  const handleResetToDefault = () => {

    setNotes(defaultNotes);

    localStorage.setItem('tradingNotes', defaultNotes);

    setIsEditing(false);

  };


  return (
    <Card style={{ marginTop: '1rem' }}>
      <CardHeader 
        title="Trading Notes" 
        action={
          <Button 
            variant="contained" 
            color="primary" 
            onClick={() => setIsEditing(!isEditing)}
          >
            {isEditing ? 'Preview' : 'Edit'}
          </Button>
        }
      />
      <CardContent>
        {isEditing ? (
          <TextField
            multiline
            rows={35}
            variant="outlined"
            fullWidth
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        ) : (
          <div style={{ maxHeight: '600px', overflow: 'auto' }}>
            <ReactMarkdown>{notes}</ReactMarkdown>
          </div>
        )}
        <div style={{ marginTop: '1rem' }}>
          {isEditing && (
            <Button
              variant="contained"
              color="primary"
              onClick={handleSave}
              style={{ marginRight: '1rem' }}
            >
              Save
            </Button>
          )}
          <Button
            variant="contained"
            color="secondary"
            onClick={handleExport}
            style={{ marginRight: '1rem' }}
          >
            Export as MD
          </Button>
          <Button

            variant="contained"

            color="warning"

            onClick={handleResetToDefault}

            style={{ marginRight: '1rem' }}

          >

            Reset to Default

          </Button>

          <Button

            variant="contained"

            color="error"

            onClick={() => {

              setNotes('');

              localStorage.removeItem('tradingNotes');

            }}

          >

            Clear Notes

          </Button>

        </div>

      </CardContent>
    </Card>
  );
};

export default TradingNotes;