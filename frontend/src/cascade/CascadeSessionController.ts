import type { CascadeAudioCapture } from './CascadeAudioCapture';
import { MicPcmCapture } from './MicPcmCapture';
import { DEFAULT_LANGUAGE_PAIR, type LanguagePair } from '../api';
import { ListenerSet } from '../session/listenerSet';
import { runSessionStart } from '../session/sessionStart';
import {
  CASCADE_ENVELOPE_VERSION,
  CascadeMessageType,
  INITIAL_CASCADE_SESSION_STATE,
  type CascadeBargeInPayload,
  type CascadeErrorKind,
  type CascadeErrorPayload,
  type CascadeSessionState,
  type CascadeSessionStatus,
  type CascadeTtsAudioEndPayload,
  type CascadeTtsAudioStartPayload,
} from './types';

/** Path the cascade audio WebSocket is served at, proxied to the backend by Vite (see `vite.config.ts`). */
const CASCADE_WS_PATH = '/ws/cascade';

/** Builds the absolute `ws(s)://` URL for the cascade endpoint from the page's own origin. */
function cascadeWebSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${CASCADE_WS_PATH}`;
}

/** One parsed `{ v, type, payload }` control/event frame off the cascade WebSocket. */
interface CascadeEnvelope {
  v?: number;
  type?: string;
  payload?: unknown;
}

/**
 * The in-flight `connectAndStream()` handshake state {@link handleSocketMessage}/
 * {@link handleEnvelope} need in order to react to a message without
 * `connectAndStream` itself growing a steady-state event switch: the stream
 * to hand mic capture once `session.ready` arrives, the socket to send
 * captured chunks over, and the settle functions (plus a way to check
 * whether one already fired) that resolve or reject `connectAndStream`'s
 * promise.
 */
interface CascadeHandshake {
  stream: MediaStream;
  socket: WebSocket;
  /** Whether `connectAndStream`'s promise has already settled (resolved or rejected). */
  isSettled: () => boolean;
  settleResolve: () => void;
  settleReject: (message: string) => void;
}

/** Collaborators the controller needs, swappable in tests for jsdom's lack of real WebSocket/AudioContext/AudioWorklet APIs. */
export interface CascadeSessionControllerDeps {
  /** Captures the local microphone. */
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** Opens the transport WebSocket to the cascade backend. */
  createWebSocket: (url: string) => WebSocket;
  /** Builds a fresh mic-to-PCM16 capture pipeline for one session. */
  createAudioCapture: () => CascadeAudioCapture;
}

function defaultDeps(): CascadeSessionControllerDeps {
  return {
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createWebSocket: (url) => new WebSocket(url),
    createAudioCapture: () => new MicPcmCapture(),
  };
}

type Listener = (state: CascadeSessionState) => void;
/** Receives one JSON-parsed envelope off the cascade WebSocket, as-is, for adapters to interpret. */
type EventListener = (event: unknown) => void;

/**
 * One non-fatal, per-stage failure (issue #12: `recoverable: true` on an
 * `error` envelope) — the session keeps running exactly as it was;
 * `CascadeInterpreterSession.subscribeToNotice` is what turns this into the
 * mode-agnostic `SessionNotice` shared UI renders as a dismissible strip.
 * `utteranceId` is `null` for a `"session"`-stage recoverable error not tied
 * to any one utterance (e.g. an unknown control-message type).
 */
export interface CascadeNoticeEvent {
  message: string;
  utteranceId: string | null;
}
type NoticeListener = (notice: CascadeNoticeEvent) => void;

/**
 * One event in a single TTS (Text-to-Speech) utterance's binary-audio
 * window, already associated with its `utteranceId` by the state machine in
 * {@link CascadeSessionController} (see the `onmessage` handling of
 * `tts.audio.start`/binary frames/`tts.audio.end`) — consumers
 * (`AudioPlaybackQueue`) never need to parse envelopes or track windows
 * themselves.
 */
export type CascadeAudioEvent =
  | { kind: 'start'; utteranceId: string; sampleRateHz: number }
  | { kind: 'chunk'; utteranceId: string; data: ArrayBuffer }
  | { kind: 'end'; utteranceId: string }
  /**
   * A `bargein` envelope (issue #11): every target-lane utteranceId the
   * backend just superseded. Emitted only when the aggregated `bargein`
   * envelope actually names at least one id — see
   * {@link CascadeSessionController}'s handling of
   * `CascadeMessageType.Bargein`.
   */
  | { kind: 'bargein'; supersededUtteranceIds: string[] };
/** Receives one {@link CascadeAudioEvent} — the TTS playback queue's only input. */
type AudioEventListener = (event: CascadeAudioEvent) => void;

/**
 * Owns the transport for a single cascade-mode session: capturing the mic,
 * opening the `/ws/cascade` WebSocket, running the `session.start` /
 * `session.ready` handshake (see `backend/CascadeAudioSession.cs`), and only
 * then streaming downsampled PCM16 audio frames until `stop()`.
 *
 * Structurally parallel to `RealtimeSessionController` — same status states,
 * generation-counter teardown safety, DI'd collaborators — so the two modes
 * share a UI shape even though the transport underneath (WebRTC vs. a raw
 * WebSocket + AudioWorklet) is entirely different. UI consumes only
 * `getState()`/`subscribe()`; no WebSocket, AudioContext, or envelope detail
 * leaks past this boundary.
 */
export class CascadeSessionController {
  private readonly deps: CascadeSessionControllerDeps;
  private readonly listeners = new ListenerSet<CascadeSessionState>();
  private readonly eventListeners = new ListenerSet<unknown>();
  private readonly audioListeners = new ListenerSet<CascadeAudioEvent>();
  private readonly noticeListeners = new ListenerSet<CascadeNoticeEvent>();

  private state: CascadeSessionState = INITIAL_CASCADE_SESSION_STATE;
  private localStream: MediaStream | null = null;
  private socket: WebSocket | null = null;
  private audioCapture: CascadeAudioCapture | null = null;
  /**
   * Set while inside a `tts.audio.start`/`tts.audio.end` window, to the
   * `utteranceId` every binary frame received in between belongs to (per
   * the backend's guarantee that TTS audio for different utterances is
   * never interleaved — see issue #7). `null` outside any such window, in
   * which case a stray binary frame is dropped rather than guessed at.
   */
  private currentAudioUtteranceId: string | null = null;
  /** Bumped on every start()/stop() so a stale async start() can detect it was superseded. */
  private generation = 0;
  /**
   * Set only while a handshake (`session.start` sent, `session.ready` not
   * yet received) is in flight. Lets `teardown()` force-settle a pending
   * `start()` — e.g. the user hits Stop while still connecting — instead of
   * leaving it awaiting a WebSocket event that will never arrive because
   * teardown just removed the socket's event handlers.
   */
  private pendingReject: ((message: string) => void) | null = null;

  constructor(deps: Partial<CascadeSessionControllerDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  /** Current session state snapshot. */
  getState(): CascadeSessionState {
    return this.state;
  }

  /** Subscribes to state changes; returns an unsubscribe function. Fires once immediately with the current state. */
  subscribe(listener: Listener): () => void {
    const unsubscribe = this.listeners.add(listener);
    listener(this.state);
    return unsubscribe;
  }

  /**
   * Subscribes to JSON-parsed envelopes off the cascade WebSocket
   * (transcript partials/finals, control frames, everything the server
   * sends) — unfiltered. Callers (e.g. the transcript adapter) pick out
   * what they care about. Returns an unsubscribe function.
   */
  subscribeToEvents(listener: EventListener): () => void {
    return this.eventListeners.add(listener);
  }

  /**
   * Subscribes to {@link CascadeAudioEvent}s — the `tts.audio.start`/binary
   * frame/`tts.audio.end` window, already parsed and associated with an
   * `utteranceId` — for a TTS playback queue to consume without touching the
   * WebSocket or envelope details itself. Returns an unsubscribe function.
   */
  subscribeToAudio(listener: AudioEventListener): () => void {
    return this.audioListeners.add(listener);
  }

  /**
   * Subscribes to {@link CascadeNoticeEvent}s (issue #12) — every
   * `recoverable: true` `error` envelope received once this session is
   * `'connected'`, distinct from `subscribeToEvents`' unfiltered fan-out so
   * `CascadeInterpreterSession` doesn't need to re-parse the envelope shape
   * itself. Returns an unsubscribe function.
   */
  subscribeToNotice(listener: NoticeListener): () => void {
    return this.noticeListeners.add(listener);
  }

  private setState(
    status: CascadeSessionStatus,
    errorMessage: string | null = null,
    errorKind: CascadeErrorKind = null,
    reconnectable = false,
  ): void {
    this.state = { status, errorMessage, errorKind, reconnectable };
    this.listeners.emit(this.state);
  }

  /**
   * Requests mic access, opens the cascade WebSocket, completes the
   * `session.start`/`session.ready` handshake, and only then starts
   * streaming PCM16 audio frames — nothing is ever sent before the server
   * has acknowledged the format it expects. A no-op while already
   * requesting/connecting/connected; call `stop()` first to retry from `'error'`.
   *
   * @param pair - Source/target language pair to send in `session.start`.
   *   Defaults to {@link DEFAULT_LANGUAGE_PAIR} (en -> es) when omitted,
   *   matching the backend's own default.
   */
  async start(pair: LanguagePair = DEFAULT_LANGUAGE_PAIR): Promise<void> {
    await runSessionStart({
      status: this.state.status,
      bumpGeneration: () => ++this.generation,
      isCurrent: (generation) => generation === this.generation,
      setState: (status, errorMessage, errorKind, reconnectable) =>
        this.setState(status, errorMessage, errorKind, reconnectable),
      getUserMedia: this.deps.getUserMedia,
      storeStream: (stream) => {
        this.localStream = stream;
      },
      connect: (stream) => this.connectAndStream(stream, pair),
      teardown: () => this.teardown(false),
      fallbackErrorMessage: 'Failed to start the cascade session.',
    });
  }

  /**
   * Opens the socket, sends `session.start`, waits for `session.ready`, then
   * starts mic capture streaming chunks over the socket. Resolves once
   * capture is running; rejects on an `error` envelope, a socket error, an
   * unexpected close, or a capture-start failure — whichever comes first.
   *
   * Limited to socket setup and settlement wiring — routing an incoming
   * message and reacting to what it says both happen in
   * {@link handleSocketMessage}/{@link handleEnvelope}, which this method
   * hands a {@link CascadeHandshake} so they can resolve/reject the same
   * promise without this method itself growing a steady-state event switch.
   */
  private connectAndStream(stream: MediaStream, pair: LanguagePair): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const settleResolve = () => {
        if (settled) return;
        settled = true;
        this.pendingReject = null;
        resolve();
      };
      const settleReject = (message: string) => {
        if (settled) return;
        settled = true;
        this.pendingReject = null;
        reject(new Error(message));
      };
      this.pendingReject = settleReject;

      const socket = this.deps.createWebSocket(cascadeWebSocketUrl());
      socket.binaryType = 'arraybuffer';
      this.socket = socket;

      const handshake: CascadeHandshake = {
        stream,
        socket,
        isSettled: () => settled,
        settleResolve,
        settleReject,
      };

      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            v: CASCADE_ENVELOPE_VERSION,
            type: CascadeMessageType.SessionStart,
            payload: { sourceLang: pair.sourceLang, targetLang: pair.targetLang },
          }),
        );
      };

      socket.onmessage = (event: MessageEvent) => this.handleSocketMessage(event, handshake);

      socket.onerror = () => {
        if (!settled) {
          settleReject('The cascade WebSocket connection failed.');
        } else {
          this.handlePostConnectFailure('The cascade WebSocket connection failed.');
        }
      };

      socket.onclose = (event: CloseEvent) => {
        if (!settled) {
          settleReject(event.reason || 'The cascade WebSocket closed before the session was ready.');
        } else {
          this.handlePostConnectFailure(event.reason || 'The cascade WebSocket closed unexpectedly.');
        }
      };
    });
  }

  /**
   * Routes one raw WebSocket message. A binary frame is a raw PCM16LE TTS
   * audio chunk (`binaryType` is `'arraybuffer'`, set in
   * {@link connectAndStream}) — no envelope, no utteranceId of its own. Per
   * the backend's framing contract (issue #7), it belongs to whichever
   * utterance's `tts.audio.start`/`tts.audio.end` window we're currently
   * inside; outside any such window there's no sound destination to
   * associate it with, so it's dropped. A string frame is a JSON
   * `{ v, type, payload }` control/event envelope: fanned out unfiltered to
   * `subscribeToEvents` subscribers (transcript partials/finals included)
   * before {@link handleEnvelope} applies this controller's own
   * handshake/state-machine handling to it.
   */
  private handleSocketMessage(event: MessageEvent, handshake: CascadeHandshake): void {
    if (typeof event.data !== 'string') {
      const utteranceId = this.currentAudioUtteranceId;
      if (utteranceId) {
        const data = event.data as ArrayBuffer;
        this.audioListeners.emit({ kind: 'chunk', utteranceId, data });
      } else {
        console.warn('CascadeSessionController: dropping a binary audio frame received outside any tts.audio.start/tts.audio.end window.');
      }
      return;
    }

    let envelope: CascadeEnvelope;
    try {
      envelope = JSON.parse(event.data) as CascadeEnvelope;
    } catch {
      return; // A malformed control frame shouldn't take down the session.
    }

    this.eventListeners.emit(envelope);
    this.handleEnvelope(envelope, handshake);
  }

  /**
   * Applies one JSON-parsed control/event envelope's effect on this
   * controller's own state machine: completing the `session.ready` handshake
   * and starting mic capture, handling pre-/post-handshake `error` envelopes
   * (issue #12's recoverable-notice vs. fatal-failure split), and TTS audio
   * window bookkeeping/fan-out (issue #7's start/chunk/end windowing, issue
   * #11's barge-in). Everything `connectAndStream`'s `onmessage` used to do
   * inline for a parsed envelope, pulled out so that method stays limited to
   * socket setup and settlement wiring.
   */
  private handleEnvelope(envelope: CascadeEnvelope, handshake: CascadeHandshake): void {
    const { stream, socket, isSettled, settleResolve, settleReject } = handshake;

    if (envelope.type === CascadeMessageType.SessionReady) {
      // A duplicate/late ready after the handshake already settled, or one
      // arriving after a capture pipeline is already running (e.g. a
      // duplicate `session.ready` sent before the first one's capture-start
      // resolved), must not start a second capture pipeline alongside it.
      if (isSettled() || this.audioCapture !== null) return;
      this.audioCapture = this.deps.createAudioCapture();
      this.audioCapture
        .start(stream, (chunk) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(chunk);
        })
        .then(settleResolve)
        .catch((captureError: unknown) => {
          settleReject(captureError instanceof Error ? captureError.message : 'Failed to start mic capture.');
        });
    } else if (envelope.type === CascadeMessageType.Error) {
      const payload = envelope.payload as CascadeErrorPayload | undefined;
      const message = payload?.message ?? 'The cascade server reported an error.';
      if (!isSettled()) {
        // A failure before the handshake settled always fails start() outright —
        // recoverable or not, there's no live session yet for a one-off notice to
        // apply to.
        settleReject(message);
      } else if (payload?.recoverable === false) {
        // Issue #12: this stage (or the session/transport itself) is now dead for
        // the rest of the session — e.g. STT's one reopen attempt also failed.
        this.handlePostConnectFailure(message);
      } else {
        // recoverable: true (or, defensively, a payload missing the field
        // altogether) — one utterance's stage failed but the session keeps running
        // exactly as before; surfaced as a notice instead of tearing the session
        // down.
        this.noticeListeners.emit({ message, utteranceId: payload?.utteranceId ?? null });
      }
    } else if (envelope.type === CascadeMessageType.TtsAudioStart) {
      const payload = envelope.payload as CascadeTtsAudioStartPayload | undefined;
      if (payload?.utteranceId) {
        this.currentAudioUtteranceId = payload.utteranceId;
        this.audioListeners.emit({ kind: 'start', utteranceId: payload.utteranceId, sampleRateHz: payload.sampleRateHz });
      }
    } else if (envelope.type === CascadeMessageType.TtsAudioEnd) {
      const payload = envelope.payload as CascadeTtsAudioEndPayload | undefined;
      if (payload?.utteranceId) {
        // A stray/duplicate end for an utterance we're not currently
        // inside the window of is ignored rather than clobbering
        // whatever window (if any) is actually open.
        if (this.currentAudioUtteranceId === payload.utteranceId) {
          this.currentAudioUtteranceId = null;
        }
        this.audioListeners.emit({ kind: 'end', utteranceId: payload.utteranceId });
      }
    } else if (envelope.type === CascadeMessageType.Bargein) {
      const payload = envelope.payload as CascadeBargeInPayload | undefined;
      const supersededUtteranceIds = Array.isArray(payload?.supersededUtteranceIds)
        ? payload.supersededUtteranceIds.filter((id): id is string => typeof id === 'string')
        : [];
      if (supersededUtteranceIds.length > 0) {
        if (this.currentAudioUtteranceId && supersededUtteranceIds.includes(this.currentAudioUtteranceId)) {
          // Closes the window now rather than waiting for tts.audio.end —
          // the known benign race (issue #11) is that a barged-in
          // utterance's tts.audio.end may never arrive at all, since the
          // backend aborted mid-synthesis. Leaving the window open would
          // misattribute every future binary frame (belonging to
          // whatever utterance starts next) to this now-superseded id
          // forever.
          this.currentAudioUtteranceId = null;
        }
        this.audioListeners.emit({ kind: 'bargein', supersededUtteranceIds });
      }
    }
  }

  /**
   * Transitions a live `'connected'` session to `'error'` on a post-handshake
   * socket problem, or a `recoverable: false` stage/session error (issue
   * #12). A no-op otherwise (e.g. our own teardown already closed the
   * socket). Marks the resulting state `reconnectable: true` so the shared UI
   * offers "Reconnect" (fresh `start()`, same pair, transcript preserved)
   * rather than treating this like a pre-connect failure.
   */
  private handlePostConnectFailure(message: string): void {
    if (this.state.status !== 'connected') return;
    this.teardown(false);
    this.setState('error', message, null, true);
  }

  /** Tears down the WebSocket and mic capture, then returns to `'idle'`. Idempotent. */
  stop(): void {
    this.generation++;
    this.teardown(true);
    this.setState('idle');
  }

  /**
   * Releases the audio pipeline and socket. `sendStop` is false when tearing
   * down after a failed/aborted start (nothing to gracefully end) or a
   * server-initiated error (the server already knows), true only for a
   * user-initiated `stop()`, which sends `session.stop` before closing.
   */
  private teardown(sendStop: boolean): void {
    this.currentAudioUtteranceId = null;

    if (this.pendingReject) {
      // Force-settle a handshake still in flight so the awaiting start() can
      // observe the generation bump and return, rather than hang forever
      // once we remove the socket's event handlers below.
      const reject = this.pendingReject;
      this.pendingReject = null;
      reject('Session was stopped.');
    }

    if (this.audioCapture) {
      void this.audioCapture.stop();
      this.audioCapture = null;
    }

    if (this.socket) {
      const socket = this.socket;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (sendStop && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ v: CASCADE_ENVELOPE_VERSION, type: CascadeMessageType.SessionStop }));
      }
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
      this.socket = null;
    }

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) track.stop();
      this.localStream = null;
    }
  }
}
