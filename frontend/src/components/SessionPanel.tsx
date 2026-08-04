import type { LatencyReport, LatencySessionAverages } from '../latency/types';
import type { SessionMode, SessionStatus } from '../session/InterpreterSession';
import type { TranscriptEntry } from '../transcript/types';
import { LatencyPanel } from './LatencyPanel';
import { TranscriptPanel } from './TranscriptPanel';

const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: 'Idle',
  'requesting-mic': 'Requesting microphone...',
  connecting: 'Connecting...',
  connected: 'Connected',
  error: 'Error',
};

/** Toggle labels for the two transports — the one piece of this component allowed to know `SessionMode` has two values. */
const MODE_LABEL: Record<SessionMode, string> = {
  realtime: 'Realtime',
  cascade: 'Cascade',
};

const MODES: SessionMode[] = ['realtime', 'cascade'];

export interface SessionPanelProps {
  /** Which transport is currently selected/active. */
  mode: SessionMode;
  status: SessionStatus;
  /** Human-readable failure reason, rendered only when `status` is `'error'`. */
  errorMessage: string | null;
  /** True while a mid-session mode switch is tearing the old transport down and bringing the new one up. */
  switching: boolean;
  /** Every transcript entry accumulated so far, across both lanes and (per issue #9) across mode switches. */
  transcriptEntries: TranscriptEntry[];
  /** The most recently appeared utterances' latency breakdowns (issue #10), preserved across mode switches like `transcriptEntries`. */
  latencyReports: LatencyReport[];
  /** Session-wide running latency averages (issue #10). */
  latencyAverages: LatencySessionAverages;
  /** Called when the listener picks a mode from the toggle — pre-session this just selects it; mid-session it triggers a switch. */
  onModeChange: (mode: SessionMode) => void;
  onStart: () => void;
  onStop: () => void;
}

/**
 * Single, mode-agnostic session panel (issue #9): a Realtime/Cascade toggle,
 * Start/Stop, a status line, and one shared `TranscriptPanel`. Replaces the
 * previous `RealtimeSessionPanel`/`CascadeSessionPanel` pair that rendered
 * side by side.
 *
 * Every prop here is transport-agnostic — `mode`/`onModeChange` are the one
 * place this component is allowed to know `SessionMode` has exactly two
 * values (the toggle itself); status, errors, and transcript entries all
 * come from `useInterpreterSession`, which is the only thing that ever
 * touches a concrete `RealtimeInterpreterSession`/`CascadeInterpreterSession`.
 */
export function SessionPanel({
  mode,
  status,
  errorMessage,
  switching,
  transcriptEntries,
  latencyReports,
  latencyAverages,
  onModeChange,
  onStart,
  onStop,
}: SessionPanelProps) {
  const isBusy = status === 'requesting-mic' || status === 'connecting';
  const isConnected = status === 'connected';
  const statusLabel = switching ? `Switching to ${MODE_LABEL[mode]}...` : STATUS_LABEL[status];

  return (
    <section className="session-panel" aria-label="Interpreter session">
      <div className="session-panel__mode-toggle" role="radiogroup" aria-label="Interpretation mode">
        {MODES.map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="radio"
            aria-checked={mode === candidate}
            className="session-panel__mode-button"
            data-active={mode === candidate}
            disabled={switching}
            onClick={() => onModeChange(candidate)}
          >
            {MODE_LABEL[candidate]}
          </button>
        ))}
      </div>

      <p className="session-panel__status" data-status={status} data-switching={switching}>
        <span className="session-panel__dot" aria-hidden="true" />
        {statusLabel}
      </p>

      {status === 'error' && errorMessage && (
        <p className="session-panel__error" role="alert">
          {errorMessage}
        </p>
      )}

      <div className="session-panel__controls">
        <button type="button" onClick={onStart} disabled={isBusy || isConnected || switching}>
          Start
        </button>
        <button type="button" onClick={onStop} disabled={status === 'idle' || switching}>
          Stop
        </button>
      </div>

      <div className="session-panel__panels">
        <TranscriptPanel entries={transcriptEntries} />
        <LatencyPanel mode={mode} recentReports={latencyReports} averages={latencyAverages} />
      </div>
    </section>
  );
}
