import type { CascadeAudioCapture } from './CascadeAudioCapture';
import { MicPcmCapture } from './MicPcmCapture';
import {
  CASCADE_ENVELOPE_VERSION,
  CascadeMessageType,
  INITIAL_CASCADE_SESSION_STATE,
  type CascadeErrorPayload,
  type CascadeSessionState,
  type CascadeSessionStatus,
  type CascadeTtsAudioEndPayload,
  type CascadeTtsAudioStartPayload,
} from './types';

/** Hardcoded source/target languages for now — per-session language selection is issue #8. */
const SOURCE_LANG = 'en';
const TARGET_LANG = 'es';

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
  | { kind: 'end'; utteranceId: string };
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
  private readonly listeners = new Set<Listener>();
  private readonly eventListeners = new Set<EventListener>();
  private readonly audioListeners = new Set<AudioEventListener>();

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
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Subscribes to JSON-parsed envelopes off the cascade WebSocket
   * (transcript partials/finals, control frames, everything the server
   * sends) — unfiltered. Callers (e.g. the transcript adapter) pick out
   * what they care about. Returns an unsubscribe function.
   */
  subscribeToEvents(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  /**
   * Subscribes to {@link CascadeAudioEvent}s — the `tts.audio.start`/binary
   * frame/`tts.audio.end` window, already parsed and associated with an
   * `utteranceId` — for a TTS playback queue to consume without touching the
   * WebSocket or envelope details itself. Returns an unsubscribe function.
   */
  subscribeToAudio(listener: AudioEventListener): () => void {
    this.audioListeners.add(listener);
    return () => {
      this.audioListeners.delete(listener);
    };
  }

  private setState(status: CascadeSessionStatus, errorMessage: string | null = null): void {
    this.state = { status, errorMessage };
    for (const listener of this.listeners) listener(this.state);
  }

  /**
   * Requests mic access, opens the cascade WebSocket, completes the
   * `session.start`/`session.ready` handshake, and only then starts
   * streaming PCM16 audio frames — nothing is ever sent before the server
   * has acknowledged the format it expects. A no-op while already
   * requesting/connecting/connected; call `stop()` first to retry from `'error'`.
   */
  async start(): Promise<void> {
    if (
      this.state.status === 'requesting-mic' ||
      this.state.status === 'connecting' ||
      this.state.status === 'connected'
    ) {
      return;
    }

    const myGeneration = ++this.generation;
    this.setState('requesting-mic');

    try {
      const localStream = await this.deps.getUserMedia({ audio: true });
      if (myGeneration !== this.generation) {
        // stop() ran while the mic prompt was pending; discard the now-unwanted stream.
        for (const track of localStream.getTracks()) track.stop();
        return;
      }
      this.localStream = localStream;

      this.setState('connecting');
      await this.connectAndStream(localStream);
      if (myGeneration !== this.generation) return;

      this.setState('connected');
    } catch (error) {
      if (myGeneration !== this.generation) return;
      this.teardown(false);
      const message = error instanceof Error ? error.message : 'Failed to start the cascade session.';
      this.setState('error', message);
    }
  }

  /**
   * Opens the socket, sends `session.start`, waits for `session.ready`, then
   * starts mic capture streaming chunks over the socket. Resolves once
   * capture is running; rejects on an `error` envelope, a socket error, an
   * unexpected close, or a capture-start failure — whichever comes first.
   */
  private connectAndStream(stream: MediaStream): Promise<void> {
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

      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            v: CASCADE_ENVELOPE_VERSION,
            type: CascadeMessageType.SessionStart,
            payload: { sourceLang: SOURCE_LANG, targetLang: TARGET_LANG },
          }),
        );
      };

      socket.onmessage = (event: MessageEvent) => {
        if (typeof event.data !== 'string') {
          // A raw PCM16LE TTS audio frame (binaryType is 'arraybuffer', set
          // above) — no envelope, no utteranceId of its own. Per the
          // backend's framing contract (issue #7), it belongs to whichever
          // utterance's tts.audio.start/tts.audio.end window we're
          // currently inside; outside any such window there's no sound
          // destination to associate it with, so it's dropped.
          const utteranceId = this.currentAudioUtteranceId;
          if (utteranceId) {
            const data = event.data as ArrayBuffer;
            for (const listener of this.audioListeners) listener({ kind: 'chunk', utteranceId, data });
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

        // Fan out every envelope (transcript partials/finals included) to subscribers
        // before this method's own handshake-specific handling below, so adapters see
        // transcript events without this controller knowing their shape.
        for (const listener of this.eventListeners) listener(envelope);

        if (envelope.type === CascadeMessageType.SessionReady) {
          if (settled) return; // A duplicate/late ready after the handshake already settled.
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
          const message = (envelope.payload as CascadeErrorPayload | undefined)?.message
            ?? 'The cascade server reported an error.';
          if (!settled) {
            settleReject(message);
          } else {
            this.handlePostConnectFailure(message);
          }
        } else if (envelope.type === CascadeMessageType.TtsAudioStart) {
          const payload = envelope.payload as CascadeTtsAudioStartPayload | undefined;
          if (payload?.utteranceId) {
            this.currentAudioUtteranceId = payload.utteranceId;
            for (const listener of this.audioListeners) {
              listener({ kind: 'start', utteranceId: payload.utteranceId, sampleRateHz: payload.sampleRateHz });
            }
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
            for (const listener of this.audioListeners) listener({ kind: 'end', utteranceId: payload.utteranceId });
          }
        }
      };

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

  /** Transitions a live `'connected'` session to `'error'` on a post-handshake socket problem. A no-op otherwise (e.g. our own teardown already closed the socket). */
  private handlePostConnectFailure(message: string): void {
    if (this.state.status !== 'connected') return;
    this.teardown(false);
    this.setState('error', message);
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
