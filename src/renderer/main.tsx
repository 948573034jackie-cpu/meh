import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import './main.css';
import './reader/reader.css';

createRoot(document.getElementById('root')!).render(<App />);
