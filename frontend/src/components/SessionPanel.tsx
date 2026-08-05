import type { LatencyReport, LatencySessionAverages } from '../latency/types';
import type { SessionErrorKind, SessionMode, SessionNotice, SessionStatus } from '../session/InterpreterSession';
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

/**
 * Perceived-latency targets from the brief, keyed by mode. The mapping lives
 * here (not in `LatencyPanel`) because this component already owns the
 * mode->label mapping above; the panel renders whatever columns it's given.
 */
const BENCHMARK_HINT_MS: Record<SessionMode, number> = {
  realtime: 1_500,
  cascade: 3_000,
};

/**
 * Step-by-step guidance shown alongside the plain error message for the two
 * mic-specific failures (issue #12) — generic enough to hold across
 * browsers, since the exact wording/location of a site's mic permission
 * toggle varies (Chrome/Firefox/Safari all phrase and place it differently).
 */
const MIC_GUIDANCE: Record<Exclude<SessionErrorKind, null>, string> = {
  'mic-denied':
    "Open this site's settings (usually via the lock or info icon next to the address bar), allow microphone access, then try again.",
  'mic-not-found':
    'Connect a microphone, or check that one is enabled and selected in your system sound settings, then try again.',
};

export interface SessionPanelProps {
  /** Which transport is currently selected/active. */
  mode: SessionMode;
  status: SessionStatus;
  /** Human-readable failure reason, rendered only when `status` is `'error'`. */
  errorMessage: string | null;
  /** See `SessionState.errorKind` (issue #12) — renders mic-permission guidance in place of a bare error message. `null` for every other failure. */
  errorKind: SessionErrorKind;
  /** See `SessionState.reconnectable` (issue #12) — swaps the "Try again" retry button for "Reconnect" when a previously-live session died mid-call. */
  reconnectable: boolean;
  /** True while a mid-session mode switch is tearing the old transport down and bringing the new one up. */
  switching: boolean;
  /** Every transcript entry accumulated so far, across both lanes and (per issue #9) across mode switches. */
  transcriptEntries: TranscriptEntry[];
  /** The most recently appeared utterances' latency breakdowns (issue #10), preserved across mode switches like `transcriptEntries`. */
  latencyReports: LatencyReport[];
  /** Per-mode running latency averages — the scoreboard shows both modes against their own targets. */
  latencyAveragesByMode: Record<SessionMode, LatencySessionAverages>;
  /** The latest non-fatal, dismissible per-stage notice (issue #12), rendered as a strip separate from the fatal `errorMessage` — the session stays connected and transcript keeps flowing underneath it. */
  notice: SessionNotice | null;
  /** Called when the listener picks a mode from the toggle — pre-session this just selects it; mid-session it triggers a switch. */
  onModeChange: (mode: SessionMode) => void;
  onStart: () => void;
  onStop: () => void;
  /** Called from the Reconnect button (shown when `reconnectable` is true) — tears the dead transport down and starts a fresh one with the same pair, preserving transcript history. */
  onReconnect: () => void;
  /** Called to dismiss the current `notice`. */
  onDismissNotice: () => void;
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
  errorKind,
  reconnectable,
  switching,
  transcriptEntries,
  latencyReports,
  latencyAveragesByMode,
  notice,
  onModeChange,
  onStart,
  onStop,
  onReconnect,
  onDismissNotice,
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
        <div className="session-panel__error-panel" role="alert">
          <p className="session-panel__error">{errorMessage}</p>
          {errorKind && <p className="session-panel__error-guidance">{MIC_GUIDANCE[errorKind]}</p>}
          {reconnectable ? (
            <button type="button" className="session-panel__reconnect" onClick={onReconnect}>
              Reconnect
            </button>
          ) : (
            <button type="button" className="session-panel__retry" onClick={onStart}>
              Try again
            </button>
          )}
        </div>
      )}

      {status === 'connected' && notice && (
        <div className="session-panel__notice" role="status">
          <p>{notice.message}</p>
          <button type="button" className="session-panel__notice-dismiss" onClick={onDismissNotice} aria-label="Dismiss">
            Dismiss
          </button>
        </div>
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
        <LatencyPanel
          modes={MODES.map((candidate) => ({
            mode: candidate,
            label: MODE_LABEL[candidate],
            targetMs: BENCHMARK_HINT_MS[candidate],
            averages: latencyAveragesByMode[candidate],
          }))}
          recentReports={latencyReports}
        />
      </div>
    </section>
  );
}
