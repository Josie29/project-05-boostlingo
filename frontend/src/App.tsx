import { useState } from 'react';
import { BackendStatus } from './components/BackendStatus';
import { LanguagePairSelector } from './components/LanguagePairSelector';
import { SessionPanel } from './components/SessionPanel';
import { isLiveStatus } from './session/InterpreterSession';
import { useInterpreterSession } from './session/useInterpreterSession';
import { DEFAULT_LANGUAGE_PAIR, type LanguagePair } from './api';
import './App.css';

/**
 * App shell for the AI Interpreter Workbench. Owns the shared source/target
 * language pair (issue #8) so whichever transport is active always
 * negotiates the same pair on its next Start, and disables the selector
 * while a session is live or a mode switch is in flight — changing
 * languages mid-session remains out of scope (issue #9 only formalizes
 * switching *transports* mid-session, not languages).
 */
function App() {
  const [pair, setPair] = useState<LanguagePair>(DEFAULT_LANGUAGE_PAIR);
  const session = useInterpreterSession(pair);
  const isActive = isLiveStatus(session.status) || session.switching;

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
        <LanguagePairSelector pair={pair} onChange={setPair} disabled={isActive} />
        <SessionPanel
          mode={session.mode}
          status={session.status}
          errorMessage={session.errorMessage}
          switching={session.switching}
          transcriptEntries={session.transcriptEntries}
          latencyReports={session.latencyReports}
          latencyAverages={session.latencyAverages}
          onModeChange={session.setMode}
          onStart={session.start}
          onStop={session.stop}
        />
      </main>
    </div>
  );
}

export default App;
