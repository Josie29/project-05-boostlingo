import { INITIAL_SESSION_STATE, type SessionErrorKind, type SessionState, type SessionStatus } from '../session/sessionState';

/**
 * Lifecycle states for a cascade-mode session — a cascade-mode alias for the
 * shared {@link SessionStatus} (`../session/sessionState.ts`), which is where
 * the actual vocabulary lives now that both transports' controllers
 * converged on identical states. So shared/mode-agnostic UI can render
 * either transport's state identically; no WebSocket, AudioContext, or
 * envelope detail leaks past this boundary.
 */
export type CascadeSessionStatus = SessionStatus;

/** Cascade-mode alias for the shared {@link SessionErrorKind} (issue #12). */
export type CascadeErrorKind = SessionErrorKind;

/** Cascade-mode alias for the shared {@link SessionState} snapshot shape. */
export type CascadeSessionState = SessionState;

/** The state a controller starts in and returns to after `stop()`. */
export const INITIAL_CASCADE_SESSION_STATE: CascadeSessionState = INITIAL_SESSION_STATE;

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
  /**
   * Server to client: one pipeline stage boundary was just reached for one
   * utterance (issue #10, per-stage latency instrumentation). See
   * `../latency/cascadeLatencyAdapter.ts`, the only place besides
   * `CascadeSessionController`'s unfiltered fan-out that should ever inspect
   * this envelope type.
   */
  LatencyMark: 'latency.mark',
  /**
   * Server to client (issue #11): one utterance's target-lane transcript was
   * cut short by a barge-in — sent once per superseded utterance, before the
   * aggregated {@link Bargein} envelope below. See
   * {@link CascadeTranscriptTruncatedPayload}.
   */
  TranscriptTruncated: 'transcript.truncated',
  /**
   * Server to client (issue #11): one aggregated barge-in event naming every
   * target-lane utteranceId just superseded by the caller starting to speak
   * again. Only sent when at least one utterance was actually superseded —
   * a speech-onset with nothing in flight produces neither this nor
   * {@link TranscriptTruncated}. See {@link CascadeBargeInPayload}.
   */
  Bargein: 'bargein',
} as const;

/** Payload the server echoes on `session.ready`, matching `CascadeSessionReadyPayload`. */
export interface CascadeSessionReadyPayload {
  sampleRateHz: number;
  encoding: string;
  channels: number;
}

/**
 * Payload the server sends on `error`, matching `CascadeErrorPayload`
 * (`backend/CascadeAudioSession.cs`). Extended for issue #12 with
 * `stage`/`utteranceId`/`recoverable` alongside the original `message` field
 * — additive, so a caller that only ever read `message` (pre-#12) keeps
 * working. `stage` is one of `"stt"`/`"mt"`/`"tts"`/`"session"`, typed as
 * `string` here rather than a frontend enum since nothing on this side
 * branches on which stage failed today; `utteranceId` is the source-lane id,
 * or `null` for a `"session"`-stage error not tied to any one utterance.
 */
export interface CascadeErrorPayload {
  message: string;
  stage: string;
  utteranceId: string | null;
  /**
   * `true` if the session keeps running as before after this error (one
   * failed utterance, or a hiccup a retry already resolved elsewhere);
   * `false` if `stage` is now unusable for the rest of the session and the
   * client should transition to `'error'` rather than treat this as a
   * one-off. See `CascadeSessionController`'s handling of this envelope.
   */
  recoverable: boolean;
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

/**
 * Payload the server sends on `transcript.truncated` (issue #11), matching
 * `CascadeTranscriptTruncatedPayload` (`backend/CascadeAudioSession.cs`).
 * `utteranceId` is the *target*-lane id — the same id space
 * `tts.audio.start`/`tts.audio.end` use, not the source-lane id
 * `transcript.partial`/`.final` for the *source* lane would use.
 */
export interface CascadeTranscriptTruncatedPayload {
  utteranceId: string;
}

/**
 * Payload the server sends on `bargein` (issue #11), matching
 * `CascadeBargeInPayload` (`backend/CascadeAudioSession.cs`).
 * `supersededUtteranceIds` are all target-lane ids, the same id space
 * `tts.audio.start`/`tts.audio.end` use.
 */
export interface CascadeBargeInPayload {
  supersededUtteranceIds: string[];
  serverTimeMs: number;
}
