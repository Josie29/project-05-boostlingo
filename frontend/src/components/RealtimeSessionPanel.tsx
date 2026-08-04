import { useRealtimeSession } from '../realtime/useRealtimeSession';
import type { RealtimeSessionStatus } from '../realtime/types';

const STATUS_LABEL: Record<RealtimeSessionStatus, string> = {
  idle: 'Idle',
  'requesting-mic': 'Requesting microphone...',
  connecting: 'Connecting...',
  connected: 'Connected',
  error: 'Error',
};

/**
 * Start/Stop control for a Realtime (WebRTC) voice-to-voice interpreter
 * session. Renders the connection state and, on failure, the backend's own
 * error message (e.g. a missing server-side OpenAI key) so the failure is
 * understandable rather than a generic "something went wrong".
 *
 * Contains no transport logic itself — all WebRTC/session state lives in
 * `useRealtimeSession`, so this component stays swappable if cascade mode
 * (issue #4) needs a differently-wired but similarly-shaped panel.
 */
export function RealtimeSessionPanel() {
  const { status, errorMessage, start, stop } = useRealtimeSession();

  const isBusy = status === 'requesting-mic' || status === 'connecting';
  const isConnected = status === 'connected';

  return (
    <section className="realtime-session" aria-label="Realtime voice session">
      <p className="realtime-session__status" data-status={status}>
        <span className="realtime-session__dot" aria-hidden="true" />
        {STATUS_LABEL[status]}
      </p>

      {status === 'error' && errorMessage && (
        <p className="realtime-session__error" role="alert">
          {errorMessage}
        </p>
      )}

      <div className="realtime-session__controls">
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
