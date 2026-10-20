// First: takes a link's secret out of the address bar before any other module runs.
import './page-start/read-link-secret.js';
// Second: schema checks never ask for eval, which the page's policy refuses.
import './page-start/no-eval.js';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRoot } from './BrowserRoot.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRoot />
  </React.StrictMode>
);
