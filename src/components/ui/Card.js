import React from 'react';
import './styles.css';

const Card = ({ children, className, style }) => {
  return (
    <div className={`card ${className}`} style={style}>
      {children}
    </div>
  );
};

const CardContent = ({ children, className, style }) => {
  return (
    <div className={`card-content ${className}`} style={style}>
      {children}
    </div>
  );
};

const CardHeader = ({ children, className, style }) => {
  return (
    <div className={`card-header ${className}`} style={style}>
      {children}
    </div>
  );
};

const CardTitle = ({ children, className, style }) => {
  return (
    <h2 className={`card-title ${className}`} style={style}>
      {children}
    </h2>
  );
};

export { Card, CardContent, CardHeader, CardTitle };
