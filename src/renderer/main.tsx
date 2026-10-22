import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import './main.css';
import './reader/reader.css';

// Lets the stylesheet leave room for the macOS traffic lights only where they exist.
document.documentElement.dataset.platform = /mac/i.test(navigator.platform) ? 'mac' : 'other';

createRoot(document.getElementById('root')!).render(<App />);
