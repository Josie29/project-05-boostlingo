import { useState } from 'react';
import { BackendStatus } from './components/BackendStatus';
import { LanguagePairSelector } from './components/LanguagePairSelector';
import { RealtimeSessionPanel } from './components/RealtimeSessionPanel';
import { CascadeSessionPanel } from './components/CascadeSessionPanel';
import { DEFAULT_LANGUAGE_PAIR, type LanguagePair } from './api';
import './App.css';

/**
 * App shell for the AI Interpreter Workbench. Owns the shared source/target
 * language pair (issue #8) so both the Realtime and Cascade panels always
 * negotiate the same pair on their next Start, and disables the selector
 * while either panel reports an active session — changing languages
 * mid-session is deliberately out of scope for this issue.
 */
function App() {
  const [pair, setPair] = useState<LanguagePair>(DEFAULT_LANGUAGE_PAIR);
  const [isRealtimeActive, setIsRealtimeActive] = useState(false);
  const [isCascadeActive, setIsCascadeActive] = useState(false);

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
        <LanguagePairSelector
          pair={pair}
          onChange={setPair}
          disabled={isRealtimeActive || isCascadeActive}
        />
        <RealtimeSessionPanel pair={pair} onActiveChange={setIsRealtimeActive} />
        <CascadeSessionPanel pair={pair} onActiveChange={setIsCascadeActive} />
        <p className="app-shell__placeholder">Latency instrumentation lands here.</p>
      </main>
    </div>
  );
}

export default App;
