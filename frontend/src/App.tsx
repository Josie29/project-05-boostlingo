import { BackendStatus } from './components/BackendStatus';
import { RealtimeSessionPanel } from './components/RealtimeSessionPanel';
import { CascadeSessionPanel } from './components/CascadeSessionPanel';
import './App.css';

/**
 * App shell for the AI Interpreter Workbench. Placeholder for now — proves
 * the dev loop (SPA reaches the backend through the Vite proxy) ahead of
 * the Realtime/Cascade mode screens landing in later issues.
 */
function App() {
  return (
    <div className="app-shell">
      <header className="app-shell__header">
        <h1>AI Interpreter Workbench</h1>
        <p className="app-shell__tagline">
          Realtime API vs. Cascade Pipeline for live interpretation
        </p>
      </header>

      <main className="app-shell__main">
        <BackendStatus />
        <RealtimeSessionPanel />
        <CascadeSessionPanel />
        <p className="app-shell__placeholder">Latency instrumentation lands here.</p>
      </main>
    </div>
  );
}

export default App;
