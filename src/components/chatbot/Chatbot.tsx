// src/components/chatbot/Chatbot.tsx
import React, { useState, useRef } from 'react';
import { ChatService } from '../../services/ChatService';
import { IconButton } from '@mui/material';
import ChatIcon from '@mui/icons-material/Chat';
import CloseIcon from '@mui/icons-material/Close';
import './styles.css';

interface ChatbotProps {
  dashboardRef: React.RefObject<HTMLElement>;
}

const Chatbot: React.FC<ChatbotProps> = ({ dashboardRef }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Array<{type: 'user' | 'bot', content: string}>>([]);
  const [input, setInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !dashboardRef.current) return;

    const userMessage = input;
    setInput('');
    setMessages(prev => [...prev, { type: 'user', content: userMessage }]);
    setIsProcessing(true);

    try {
      const response = await ChatService.captureAndAnalyze(
        dashboardRef.current,
        userMessage
      );
      setMessages(prev => [...prev, { type: 'bot', content: response }]);
    } catch (error) {
      setMessages(prev => [...prev, { 
        type: 'bot', 
        content: 'Sorry, I encountered an error analyzing the dashboard.' 
      }]);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <>
      <IconButton 
        className="chatbot-toggle"
        onClick={() => setIsOpen(!isOpen)}
        sx={{
          position: 'fixed',
          top: '20px',
          right: '20px',
          zIndex: 1001,
          bgcolor: '#1976d2',
          color: 'white',
          '&:hover': {
            bgcolor: '#1565c0',
          },
        }}
      >
        {isOpen ? <CloseIcon /> : <ChatIcon />}
      </IconButton>

      <div className={`chatbot-sidebar ${isOpen ? 'open' : ''}`}>
        {

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
        }
      </div>
    </>
  );
};

export default Chatbot;
