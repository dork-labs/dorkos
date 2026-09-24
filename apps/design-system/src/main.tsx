import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Catalog } from './Catalog';
import './styles.css';

const playgroundUrl = import.meta.env.VITE_DORKOS_PLAYGROUND_URL || 'http://localhost:6241/dev';
const root = document.getElementById('root');
if (!root) throw new Error('Catalog root element is missing');

createRoot(root).render(
  <StrictMode>
    <Catalog playgroundUrl={playgroundUrl} />
  </StrictMode>
);
