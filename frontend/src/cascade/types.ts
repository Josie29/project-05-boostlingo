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
  /** Server to client: an in-progress (not yet settled) transcript segment. */
  TranscriptPartial: 'transcript.partial',
  /** Server to client: the settled transcript text for one utterance. */
  TranscriptFinal: 'transcript.final',
  /**
   * Server to client: opens the binary-audio window for one utterance's
   * synthesized speech; the raw PCM16 frames that follow (until the matching
   * `TtsAudioEnd`) belong to `payload.utteranceId`. See
   * {@link CascadeTtsAudioStartPayload}.
   */
  TtsAudioStart: 'tts.audio.start',
  /**
   * Server to client: closes the binary-audio window opened by the matching
   * `TtsAudioStart` — no more raw PCM16 frames for that utterance will
   * arrive. Not every utterance gets a start/end pair (e.g. empty MT output).
   * See {@link CascadeTtsAudioEndPayload}.
   */
  TtsAudioEnd: 'tts.audio.end',
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

/**
 * Payload the server sends on `transcript.partial`/`transcript.final`, matching
 * `CascadeTranscriptPayload` (`backend/CascadeAudioSession.cs`). `lane` is typed as
 * `string` rather than `TranscriptLane` here since this is the raw wire shape — the
 * adapter (`cascadeTranscriptAdapter.ts`) is what narrows/validates it before handing a
 * {@link TranscriptUpdate} to the shared reducer.
 */
export interface CascadeTranscriptPayload {
  utteranceId: string;
  lane: string;
  text: string;
  timestampMs: number;
}

/**
 * Payload the server sends on `tts.audio.start`, matching
 * `CascadeTtsAudioStartPayload` (`backend/CascadeAudioSession.cs`). Echoes
 * the audio format so the client never has to hardcode it, even though in
 * practice it's always 24kHz/pcm16/mono (OpenAI TTS's native output format)
 * and won't change mid-session.
 */
export interface CascadeTtsAudioStartPayload {
  utteranceId: string;
  sampleRateHz: number;
  encoding: string;
  channels: number;
}

/** Payload the server sends on `tts.audio.end`, matching `CascadeTtsAudioEndPayload`. */
export interface CascadeTtsAudioEndPayload {
  utteranceId: string;
}
