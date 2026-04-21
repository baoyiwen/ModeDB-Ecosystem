import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import { DesignerProvider } from './context/designer-context.js';
import './index.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('missing #root');
}

createRoot(root).render(
  <StrictMode>
    <DesignerProvider>
      <App />
    </DesignerProvider>
  </StrictMode>,
);
