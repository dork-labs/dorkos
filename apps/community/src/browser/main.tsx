import React from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  return (
    <main style={{ maxWidth: 640, margin: '5rem auto', padding: '1rem', fontFamily: 'system-ui' }}>
      <h1>DorkOS Community</h1>
      <p>The community service is running. Browser chat is coming in the next release.</p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
