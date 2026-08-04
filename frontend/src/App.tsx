import { BackendStatus } from './components/BackendStatus';
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
        <p className="app-shell__placeholder">
          Mode selection, transcripts, and latency instrumentation land here.
        </p>
      </main>
    </div>
  );
}

export default App;
