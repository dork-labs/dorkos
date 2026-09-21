import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRoot } from './BrowserRoot.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRoot />
  </React.StrictMode>
);
