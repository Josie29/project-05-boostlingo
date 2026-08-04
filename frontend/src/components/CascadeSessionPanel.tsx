import { useCascadeSession } from '../cascade/useCascadeSession';
import type { CascadeSessionStatus } from '../cascade/types';

const STATUS_LABEL: Record<CascadeSessionStatus, string> = {
  idle: 'Idle',
  'requesting-mic': 'Requesting microphone...',
  connecting: 'Connecting...',
  connected: 'Connected',
  error: 'Error',
};

/**
 * Start/Stop control for a Cascade (STT -> MT -> TTS) interpreter session.
 * Hardcodes English -> Spanish for now — per-session language selection is
 * issue #8. Transcript/audio playback for this mode arrive with issues
 * #5-7; for now this only proves mic capture streams cleanly over the
 * `/ws/cascade` WebSocket end to end.
 *
 * Contains no transport logic itself — all WebSocket/AudioWorklet state
 * lives in `useCascadeSession`, mirroring `RealtimeSessionPanel`'s shape so
 * the two modes are easy to compare side by side.
 */
export function CascadeSessionPanel() {
  const { status, errorMessage, start, stop } = useCascadeSession();

  const isBusy = status === 'requesting-mic' || status === 'connecting';
  const isConnected = status === 'connected';

  return (
    <section className="cascade-session" aria-label="Cascade pipeline session">
      <p className="cascade-session__status" data-status={status}>
        <span className="cascade-session__dot" aria-hidden="true" />
        {STATUS_LABEL[status]}
      </p>

      {status === 'error' && errorMessage && (
        <p className="cascade-session__error" role="alert">
          {errorMessage}
        </p>
      )}

      <div className="cascade-session__controls">
        <button type="button" onClick={start} disabled={isBusy || isConnected}>
          Start
        </button>
        <button type="button" onClick={stop} disabled={status === 'idle'}>
          Stop
        </button>
      </div>
    </section>
  );
}
