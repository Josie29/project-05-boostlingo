/**
 * Lifecycle states for a Realtime WebRTC session. This is the entire
 * transport surface the UI should ever need — no SDP, RTCPeerConnection, or
 * data-channel details leak past this boundary, so shared/mode-agnostic
 * screens can render off of it directly.
 */
export type RealtimeSessionStatus =
  | 'idle'
  | 'requesting-mic'
  | 'connecting'
  | 'connected'
  | 'error';

/**
 * Narrows *why* an `'error'` status happened (issue #12). Mirrors
 * `SessionErrorKind` (`../session/InterpreterSession.ts`) independently,
 * same as `RealtimeSessionStatus` already mirrors `SessionStatus` — see this
 * file's own top-of-file remarks on why the two never import from each other.
 */
export type RealtimeErrorKind = 'mic-denied' | 'mic-not-found' | null;

/** Small state snapshot the UI renders from. */
export interface RealtimeSessionState {
  status: RealtimeSessionStatus;
  /** Human-readable failure reason, set only when `status` is `'error'`. */
  errorMessage: string | null;
  /** See {@link RealtimeErrorKind}. `null` unless `status` is `'error'`. */
  errorKind: RealtimeErrorKind;
  /** True when a previously-`'connected'` session (e.g. a WebRTC connection drop) died, as opposed to a failure before ever connecting — drives the Reconnect vs. plain-retry affordance. See `SessionState.reconnectable`'s remarks. */
  reconnectable: boolean;
}

/** The state a controller starts in and returns to after `stop()`. */
export const INITIAL_REALTIME_SESSION_STATE: RealtimeSessionState = {
  status: 'idle',
  errorMessage: null,
  errorKind: null,
  reconnectable: false,
};
