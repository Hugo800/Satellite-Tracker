import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import { watchViewportShortfall } from './utils/viewportShortfallWatch';
import './index.css';

registerSW({ immediate: true });

const container = document.getElementById('root');
if (!container) throw new Error('Root-Element nicht gefunden');

// Hier und nicht als Hook in App.tsx oder als Inline-Skript in index.html:
// `render()` rendert asynchron, ein synchroner Aufruf davor steht also
// sicher vor dem ersten Commit – das HUD erscheint gleich mit dem richtigen
// Abstand zur Unterkante. Ein Hook liefe erst nach dem ersten Commit und im
// StrictMode doppelt, obwohl die Messung das ganze Dokument betrifft und
// nicht eine Komponente. Ein Inline-Skript liefe zwar früher, könnte die in
// scripts/verify-viewport.ts geprüfte Funktion aber nicht importieren und
// müsste sie ungeprüft doppeln; vor dem ersten Rendern ist ohnehin nur die
// schwarze Grundfläche zu sehen.
watchViewportShortfall();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
