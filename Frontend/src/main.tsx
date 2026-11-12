import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { loadHubSdk } from './lib/hub';
import './styles.css';

// Downstream Hub SDK first, so it is loading while the app starts and catches
// errors from the very first render. Off in builds without a Hub key.
loadHubSdk();

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
