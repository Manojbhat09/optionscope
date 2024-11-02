// src/components/chatbot/Chatbot.js
import React, { useState, useRef, useEffect } from 'react';
import ChatIcon from '@mui/icons-material/Chat';
import CloseIcon from '@mui/icons-material/Close';
import IconButton from '@mui/material/IconButton';
import html2canvas from 'html2canvas';
import './styles.css';

const Chatbot = ({ dashboardRef, onOpenChange}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const chatboxRef = useRef(null);


  const captureAndSendQuery = async (query) => {
    setIsProcessing(true);
    try {
      // Capture dashboard screenshot
      const canvas = await html2canvas(dashboardRef.current);
      const screenshot = canvas.toDataURL('image/png');

      // Send to backend
      const response = await fetch('http://localhost:5000/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          screenshot,
        }),
      });

      const data = await response.json();
      return data.response;
    } catch (error) {
      console.error('Error processing query:', error);
      return 'Sorry, I encountered an error processing your request.';
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!input.trim()) return;

    const userMessage = input;
    setInput('');
    setMessages(prev => [...prev, { type: 'user', content: userMessage }]);
    
    const response = await captureAndSendQuery(userMessage);
    setMessages(prev => [...prev, { type: 'bot', content: response }]);
  };

  const handleOpenChange = (isOpen) => {
    setIsOpen(isOpen);
    onOpenChange(isOpen); // Pass the state change to the parent
  };


   return (
    <>
      {/* Toggle Button */}
      <IconButton 
        className="chatbot-toggle"
        onClick={() => handleOpenChange(!isOpen)}
        style={{
          position: 'fixed',
          top: '20px',
          right: '20px',
          zIndex: 1001,
          backgroundColor: '#1976d2',
          color: 'white',
        }}
      >
        {isOpen ? <CloseIcon /> : <ChatIcon />}
      </IconButton>

      {/* Chatbot Sidebar */}
      <div className={`chatbot-sidebar ${isOpen ? 'open' : ''}`}>
        <div className="chatbot-header">
          Trading Assistant
        </div>
        <div className="chatbot-messages" ref={chatboxRef}>
          {messages.map((msg, idx) => (
            <div key={idx} className={`message ${msg.type}`}>
              {msg.content}
            </div>
          ))}
          {isProcessing && <div className="message bot">Processing...</div>}
        </div>
        <form onSubmit={handleSubmit} className="chatbot-input">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about your trading data..."
            disabled={isProcessing}
          />
          <button type="submit" disabled={isProcessing}>Send</button>
        </form>
      </div>
    </>
  );
};

export default Chatbot;
