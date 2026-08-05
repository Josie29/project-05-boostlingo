import type { LanguagePair } from '../api';
import type { LatencyReport } from '../latency/types';
import type { TranscriptUpdate } from '../transcript/types';
import { INITIAL_SESSION_STATE, type SessionErrorKind, type SessionState, type SessionStatus } from './sessionState';

export { INITIAL_SESSION_STATE, type SessionErrorKind, type SessionState, type SessionStatus };

/**
 * The two interpretation transports the workbench can drive a session with.
 * Nothing outside this module and its two adapters (`RealtimeInterpreterSession`,
 * `CascadeInterpreterSession`) should need to branch on this value — it exists
 * so the mode toggle itself has something to render two options from.
 */
export type SessionMode = 'realtime' | 'cascade';

/**
 * One non-fatal, dismissible notice (issue #12): a single cascade stage
 * failure (`recoverable: true` — one utterance's MT/TTS request failed, or
 * STT hiccuped and successfully reopened) that the session survived without
 * dropping to `'error'`. `id` changes on every new notice so
 * `SessionPanel` can tell "the listener dismissed this one" apart from "a
 * new one just arrived and should reappear even if the last one was
 * dismissed". Realtime has no per-stage failures of its own, so only
 * `CascadeInterpreterSession` ever emits one — see `InterpreterSession.subscribeToNotice`'s remarks.
 */
export interface SessionNotice {
  id: string;
  message: string;
}

/** True while a session has live resources (mic, socket, or peer connection) that a mode switch must tear down first. */
export function isLiveStatus(status: SessionStatus): boolean {
  return status === 'requesting-mic' || status === 'connecting' || status === 'connected';
}

type StateListener = (state: SessionState) => void;
type TranscriptListener = (update: TranscriptUpdate) => void;
type LatencyListener = (report: LatencyReport) => void;
type NoticeListener = (notice: SessionNotice) => void;
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
  /**
   * Subscribes to mode-agnostic {@link LatencyReport}s (issue #10), already
   * folded from whichever mode-specific signals this transport has
   * available (per-stage server marks for cascade; a single coarse
   * end-to-end measurement for Realtime — see `realtimeLatencyAdapter.ts`).
   * Optional so a future transport with no latency instrumentation at all
   * can simply omit it rather than implementing a no-op; both current
   * adapters (`RealtimeInterpreterSession`, `CascadeInterpreterSession`)
   * implement it. Returns an unsubscribe function.
   */
  subscribeToLatency?(listener: LatencyListener): Unsubscribe;
  /**
   * Subscribes to mode-agnostic {@link SessionNotice}s (issue #12): non-fatal,
   * per-stage failures that don't change `status`. Optional so a transport
   * with no notion of a "one utterance failed but the session lives" case
   * (Realtime, whose only failures are session-level) can simply omit it,
   * mirroring {@link subscribeToLatency}'s optionality. Only
   * `CascadeInterpreterSession` implements it today. Returns an unsubscribe
   * function.
   */
  subscribeToNotice?(listener: NoticeListener): Unsubscribe;
  /** Requests mic access and opens the session for the given language pair. A no-op while already live; call `stop()` first to retry from `'error'`. */
  start(pair: LanguagePair): Promise<void>;
  /** Tears the session down cleanly (safe to call from any state, including already idle). */
  stop(): void;
}

/**
 * Namespaces any transport-produced id by which mode produced it. Both
 * transports mint their transcript/latency utterance ids from OpenAI's own
 * STT (Speech-to-Text) output (`item_id` on Realtime's data channel; the
 * same field name via `OpenAiSttProvider` on cascade's `transcript.*`/
 * `latency.mark` envelopes — see `backend/Providers/OpenAiSttProvider.cs`),
 * so without this, an id from one mode could collide with an id from the
 * other in state kept across a mid-session switch (issue #9) and silently
 * merge two unrelated utterances into one entry. Called by each adapter's
 * `subscribeToTranscript`/`subscribeToLatency`, never by shared UI.
 */
export function prefixId(mode: SessionMode, id: string): string {
  return `${mode}:${id}`;
}

/** {@link prefixId}, specialized to a {@link TranscriptUpdate}'s `utteranceId` — see `prefixId`'s remarks for why this matters. */
export function prefixUtteranceId(mode: SessionMode, update: TranscriptUpdate): TranscriptUpdate {
  return { ...update, utteranceId: prefixId(mode, update.utteranceId) };
}

/** {@link prefixId}, specialized to a {@link LatencyReport}'s `utteranceId` — see `prefixId`'s remarks for why this matters. */
export function prefixLatencyReport(mode: SessionMode, report: LatencyReport): LatencyReport {
  return { ...report, utteranceId: prefixId(mode, report.utteranceId) };
}
