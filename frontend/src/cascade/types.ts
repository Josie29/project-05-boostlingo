/**
 * Lifecycle states for a cascade-mode session. Mirrors `RealtimeSessionStatus`
 * (`../realtime/types.ts`) so shared/mode-agnostic UI can render either
 * transport's state identically; no WebSocket, AudioContext, or envelope
 * detail leaks past this boundary.
 */
export type CascadeSessionStatus = 'idle' | 'requesting-mic' | 'connecting' | 'connected' | 'error';

/** Small state snapshot the UI renders from. */
export interface CascadeSessionState {
  status: CascadeSessionStatus;
  /** Human-readable failure reason, set only when `status` is `'error'`. */
  errorMessage: string | null;
}

/** The state a controller starts in and returns to after `stop()`. */
export const INITIAL_CASCADE_SESSION_STATE: CascadeSessionState = {
  status: 'idle',
  errorMessage: null,
};

/**
 * Current version of the `{ v, type, payload }` wire envelope. Matches
 * `CascadeAudioEndpoints.EnvelopeVersion` in `backend/CascadeAudioSession.cs`.
 */
export const CASCADE_ENVELOPE_VERSION = 1;

/** `type` values used on the wire, matching `CascadeMessageTypes` in `backend/CascadeAudioSession.cs`. */
export const CascadeMessageType = {
  /** Client to server: begin a session with a source/target language pair. */
  SessionStart: 'session.start',
  /** Client to server: end the session gracefully. */
  SessionStop: 'session.stop',
  /** Server to client: acknowledges `SessionStart` and echoes the required audio format. */
  SessionReady: 'session.ready',
  /** Server to client: a problem the client should surface to the user. */
  Error: 'error',
} as const;

/** Payload the server echoes on `session.ready`, matching `CascadeSessionReadyPayload`. */
export interface CascadeSessionReadyPayload {
  sampleRateHz: number;
  encoding: string;
  channels: number;
}

/** Payload the server sends on `error`, matching `CascadeErrorPayload`. */
export interface CascadeErrorPayload {
  message: string;
}
