import { INITIAL_SESSION_STATE, type SessionErrorKind, type SessionState, type SessionStatus } from '../session/sessionState';

/**
 * Lifecycle states for a Realtime WebRTC session — a Realtime-mode alias for
 * the shared {@link SessionStatus} (`../session/sessionState.ts`), which is
 * where the actual vocabulary lives now that both transports' controllers
 * converged on identical states. This is the entire transport surface the UI
 * should ever need — no SDP, RTCPeerConnection, or data-channel details leak
 * past this boundary, so shared/mode-agnostic screens can render off of it
 * directly.
 */
export type RealtimeSessionStatus = SessionStatus;

/** Realtime-mode alias for the shared {@link SessionErrorKind} (issue #12). */
export type RealtimeErrorKind = SessionErrorKind;

/** Realtime-mode alias for the shared {@link SessionState} snapshot shape. */
export type RealtimeSessionState = SessionState;

/** The state a controller starts in and returns to after `stop()`. */
export const INITIAL_REALTIME_SESSION_STATE: RealtimeSessionState = INITIAL_SESSION_STATE;
