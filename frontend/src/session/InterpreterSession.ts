import type { LanguagePair } from '../api';
import type { TranscriptUpdate } from '../transcript/types';

/**
 * The two interpretation transports the workbench can drive a session with.
 * Nothing outside this module and its two adapters (`RealtimeInterpreterSession`,
 * `CascadeInterpreterSession`) should need to branch on this value — it exists
 * so the mode toggle itself has something to render two options from.
 */
export type SessionMode = 'realtime' | 'cascade';

/**
 * Lifecycle states shared by both transports. `RealtimeSessionController` and
 * `CascadeSessionController` already independently converged on this exact
 * vocabulary, which is what makes a single mode-agnostic status display
 * possible in the first place.
 */
export type SessionStatus = 'idle' | 'requesting-mic' | 'connecting' | 'connected' | 'error';

/** Small state snapshot the UI renders from, regardless of which mode produced it. */
export interface SessionState {
  status: SessionStatus;
  /** Human-readable failure reason, set only when `status` is `'error'`. */
  errorMessage: string | null;
}

/** The state every session starts in and returns to after `stop()`. */
export const INITIAL_SESSION_STATE: SessionState = { status: 'idle', errorMessage: null };

/** True while a session has live resources (mic, socket, or peer connection) that a mode switch must tear down first. */
export function isLiveStatus(status: SessionStatus): boolean {
  return status === 'requesting-mic' || status === 'connecting' || status === 'connected';
}

type StateListener = (state: SessionState) => void;
type TranscriptListener = (update: TranscriptUpdate) => void;
type Unsubscribe = () => void;

/**
 * The transport seam issue #9 formalizes: everything the shared, mode-agnostic
 * UI is allowed to know about a session, whether it's backed by the WebRTC
 * Realtime API or the cascade STT -> MT -> TTS WebSocket pipeline underneath.
 *
 * `RealtimeInterpreterSession` and `CascadeInterpreterSession` are thin
 * adapters implementing this over `RealtimeSessionController` and
 * `CascadeSessionController` respectively — no SDP, RTCPeerConnection,
 * WebSocket, or wire-envelope detail from either transport leaks past this
 * interface. `useInterpreterSession` is the only thing that ever holds a
 * reference to a concrete `SessionMode`; every component below it (the mode
 * toggle aside) renders off of `InterpreterSession`'s state/transcript
 * surface alone.
 */
export interface InterpreterSession {
  /** Which transport this instance drives — read by the toggle UI only, never branched on by shared session UI. */
  readonly mode: SessionMode;
  /** Current state snapshot. */
  getState(): SessionState;
  /** Subscribes to state changes; returns an unsubscribe function. Fires once immediately with the current state. */
  subscribe(listener: StateListener): Unsubscribe;
  /**
   * Subscribes to mode-agnostic {@link TranscriptUpdate}s, already translated
   * from whichever wire format this transport uses. Returns an unsubscribe
   * function.
   */
  subscribeToTranscript(listener: TranscriptListener): Unsubscribe;
  /** Requests mic access and opens the session for the given language pair. A no-op while already live; call `stop()` first to retry from `'error'`. */
  start(pair: LanguagePair): Promise<void>;
  /** Tears the session down cleanly (safe to call from any state, including already idle). */
  stop(): void;
}

/**
 * Namespaces a transcript update's `utteranceId` by which transport produced
 * it. Both transports mint their ids from OpenAI's own STT (Speech-to-Text)
 * output (`item_id` on Realtime's data channel; the same field name via
 * `OpenAiSttProvider` on cascade's `transcript.*` envelopes — see
 * `backend/Providers/OpenAiSttProvider.cs`), so without this, an id from one
 * mode could collide with an id from the other in the transcript kept across
 * a mid-session switch (issue #9) and silently merge two unrelated
 * utterances into one entry. Called by each adapter's
 * `subscribeToTranscript`, never by shared UI.
 */
export function prefixUtteranceId(mode: SessionMode, update: TranscriptUpdate): TranscriptUpdate {
  return { ...update, utteranceId: `${mode}:${update.utteranceId}` };
}
