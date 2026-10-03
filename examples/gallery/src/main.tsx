import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@saitdigital/rt-dspplr/styles.css';
import './gallery.css';
import App from './App';

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
