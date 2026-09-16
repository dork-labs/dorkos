import React from 'react';
import { createRoot } from 'react-dom/client';
import { CommunityApp } from './CommunityApp.js';
import { Pairing } from './components/Pairing.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {window.location.pathname === '/pairing' ? <Pairing /> : <CommunityApp />}
  </React.StrictMode>
);
