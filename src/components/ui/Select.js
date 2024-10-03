import React from 'react';
import './styles.css';

/*
const Select = ({ children, className, style }) => {
  return (
    <div className={`select ${className}`} style={style}>
      {children}
    </div>
  );
};
*/
const SelectContent = ({ children, className, style }) => {
  return (
    <div className={`select-content ${className}`} style={style}>
      {children}
    </div>
  );
};

const SelectItem = ({ children, className, style }) => {
  return (
    <div className={`select-item ${className}`} style={style}>
      {children}
    </div>
  );
};

const SelectTrigger = ({ children, className, style }) => {
  return (
    <div className={`select-trigger ${className}`} style={style}>
      {children}
    </div>
  );
};

const SelectValue = ({ children, className, style }) => {
  return (
    <div className={`select-value ${className}`} style={style}>
      {children}
    </div>
  );
};



const Select = ({ value, onChange, children, className, style }) => {
  return (
    <div className={`select ${className}`} style={style}>
      <select value={value} onChange={onChange}>
        {children}
      </select>
    </div>
  );
};


export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue };
