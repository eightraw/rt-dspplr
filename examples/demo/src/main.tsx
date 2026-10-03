import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@saitdigital/rt-dspplr/styles.css';
import './demo.css';
import App from './App';

// StrictMode on purpose: in development React mounts, unmounts and remounts
// every component once, which is exactly the lifecycle useAudioPlayer must
// survive (dispose on unmount, re-arm on mount).
createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
