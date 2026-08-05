import { useEffect, useState } from 'react';
import { BackendStatus } from './components/BackendStatus';
import { LabPanel } from './components/LabPanel';
import { LanguagePairSelector } from './components/LanguagePairSelector';
import { SessionPanel } from './components/SessionPanel';
import { isLiveStatus } from './session/InterpreterSession';
import { useInterpreterSession } from './session/useInterpreterSession';
import {
  DEFAULT_LANGUAGE_PAIR,
  getArchitecture,
  type ArchitectureInfo,
  type CascadeStageModels,
  type LanguagePair,
} from './api';
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
  const [architecture, setArchitecture] = useState<ArchitectureInfo | null>(null);
  const [stageModels, setStageModels] = useState<CascadeStageModels>({});
  const [view, setView] = useState<'live' | 'lab'>('live');
  const session = useInterpreterSession(pair, undefined, stageModels);
  const isActive = isLiveStatus(session.status) || session.switching;

  // Model names for the architecture cards. Static per backend process, so
  // fetched once; a failure just leaves the cards without model rows.
  useEffect(() => {
    let cancelled = false;
    getArchitecture()
      .then((info) => {
        if (!cancelled) setArchitecture(info);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="app-shell">
      <header className="app-shell__header">
        <h1>AI Interpreter Workbench</h1>
        <p className="app-shell__tagline">
          Realtime API vs. Cascade Pipeline for live interpretation
        </p>
      </header>

      <main className="app-shell__main">
        <div className="app-shell__topbar">
          <BackendStatus />
          <nav className="app-shell__views" aria-label="View">
            {(['live', 'lab'] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                className="app-shell__view-tab"
                aria-pressed={view === candidate}
                onClick={() => setView(candidate)}
              >
                {candidate === 'live' ? 'Live' : 'Lab'}
              </button>
            ))}
          </nav>
        </div>
        {/* The live panel stays mounted while Lab is open: the session hook lives
            above both views, so switching views never touches a running session. */}
        <div hidden={view !== 'live'}>
        <SessionPanel
          architecture={architecture}
          pairSelector={<LanguagePairSelector pair={pair} onChange={setPair} disabled={isActive} />}
          stageModels={stageModels}
          onStageModelsChange={setStageModels}
          stageModelsLocked={isActive}
          mode={session.mode}
          status={session.status}
          errorMessage={session.errorMessage}
          errorKind={session.errorKind}
          reconnectable={session.reconnectable}
          switching={session.switching}
          transcriptEntries={session.transcriptEntries}
          latencyReports={session.latencyReports}
          latencyAveragesByMode={session.latencyAveragesByMode}
          notice={session.notice}
          onModeChange={session.setMode}
          onStart={session.start}
          onStop={session.stop}
          onReconnect={session.reconnect}
          onDismissNotice={session.dismissNotice}
        />
        </div>
        {view === 'lab' && <LabPanel pair={pair} stageModels={stageModels} />}
      </main>
    </div>
  );
}

export default App;
