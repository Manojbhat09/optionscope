import React from 'react';

const Input = ({ type, value, onChange, placeholder, className, style }) => {
  return (
    <input
      type={type}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      className={`input ${className}`}
      style={style}
    />
  );
};

export { Input };
