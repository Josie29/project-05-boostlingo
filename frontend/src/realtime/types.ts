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

/** Small state snapshot the UI renders from. */
export interface RealtimeSessionState {
  status: RealtimeSessionStatus;
  /** Human-readable failure reason, set only when `status` is `'error'`. */
  errorMessage: string | null;
}

/** The state a controller starts in and returns to after `stop()`. */
export const INITIAL_REALTIME_SESSION_STATE: RealtimeSessionState = {
  status: 'idle',
  errorMessage: null,
};
