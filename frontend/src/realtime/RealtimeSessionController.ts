import { createRealtimeSession, type LanguagePair, type RealtimeSessionInfo } from '../api';
import { ListenerSet } from '../session/listenerSet';
import { runSessionStart } from '../session/sessionStart';
import {
  INITIAL_REALTIME_SESSION_STATE,
  type RealtimeErrorKind,
  type RealtimeSessionState,
  type RealtimeSessionStatus,
} from './types';

const OPENAI_REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const DATA_CHANNEL_LABEL = 'oai-events';

/**
 * How long a `connectionState === 'disconnected'` is tolerated before it's
 * treated as a real failure. ICE (Interactive Connectivity Establishment)
 * connectivity checks routinely bounce `disconnected` -> `connected` within a
 * second or two on a flaky network without the media path actually being
 * lost — only `'failed'` is unambiguously terminal on its own. Giving
 * `'disconnected'` a short grace window avoids tearing down sessions that
 * were about to self-recover.
 */
const DISCONNECT_GRACE_MS = 5_000;

/**
 * Client event sent over the data channel as soon as it opens, turning on
 * input audio transcription for this session. The backend's session
 * request (`backend/RealtimeSession.cs`) doesn't request this — enabling it
 * here via `session.update` is the standard client-side approach and avoids
 * a backend change for a frontend-only feature (issue #3's live transcript
 * panel needs to hear back what the *caller* said, not just the
 * interpretation).
 *
 * It also pins turn detection to the same VAD (Voice Activity Detection) the
 * cascade's STT session requests (`OpenAiSttProvider.VadType`). Left unset,
 * this session would take the Realtime API's default instead, and the two
 * modes would be deciding "the speaker is done" by different algorithms — the
 * event both modes' latency windows open on. The benchmark is a comparison of
 * architectures, so turn detection has to be held constant across them.
 */
const ENABLE_INPUT_TRANSCRIPTION_EVENT = {
  type: 'session.update',
  session: {
    type: 'realtime',
    audio: {
      input: {
        transcription: {
          model: 'gpt-4o-mini-transcribe',
        },
        turn_detection: {
          type: 'semantic_vad',
        },
      },
    },
  },
};

/**
 * Posts the local SDP offer to OpenAI's Realtime calls endpoint, authenticating
 * with the ephemeral client secret, and resolves with the answer SDP.
 *
 * @throws {Error} If OpenAI responds with a non-2xx status.
 */
async function postOfferToOpenAi(offerSdp: string, session: RealtimeSessionInfo): Promise<string> {
  const response = await fetch(
    `${OPENAI_REALTIME_CALLS_URL}?model=${encodeURIComponent(session.model)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.clientSecret}`,
        'Content-Type': 'application/sdp',
      },
      body: offerSdp,
    },
  );
  if (!response.ok) {
    throw new Error(`OpenAI Realtime call setup failed (status ${response.status})`);
  }
  return response.text();
}

/** Collaborators the controller needs, swappable in tests for jsdom's lack of real WebRTC/media APIs. */
export interface RealtimeSessionControllerDeps {
  /** Requests the ephemeral session token from the backend for the given language pair (the backend's own en/es default applies if omitted). */
  fetchSessionInfo: (pair?: LanguagePair) => Promise<RealtimeSessionInfo>;
  /** Captures the local microphone. */
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** Constructs a fresh peer connection for the session. */
  createPeerConnection: () => RTCPeerConnection;
  /** Sends the local offer to OpenAI and resolves with the remote answer SDP. */
  postOffer: (offerSdp: string, session: RealtimeSessionInfo) => Promise<string>;
}

function defaultDeps(): RealtimeSessionControllerDeps {
  return {
    fetchSessionInfo: (pair) => createRealtimeSession(pair),
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createPeerConnection: () => new RTCPeerConnection(),
    postOffer: postOfferToOpenAi,
  };
}

type Listener = (state: RealtimeSessionState) => void;
/** Receives one JSON-parsed event off the data channel, as-is, for adapters to interpret. */
type EventListener = (event: unknown) => void;

/**
 * Owns the WebRTC transport for a single Realtime voice session: fetching an
 * ephemeral token, capturing the mic, negotiating the peer connection, and
 * playing remote audio back through an internal, un-mounted `<audio>`
 * element. UI consumes only `getState()`/`subscribe()` — no SDP or
 * RTCPeerConnection details are exposed, so shared UI stays transport-agnostic.
 *
 * One controller instance owns exactly one audio element for its whole
 * lifetime; repeated `start()`/`stop()` cycles reuse it and fully release
 * tracks/data channel/peer connection each time, so nothing accumulates.
 */
export class RealtimeSessionController {
  private readonly deps: RealtimeSessionControllerDeps;
  private readonly audioElement: HTMLAudioElement;
  private readonly listeners = new ListenerSet<RealtimeSessionState>();
  private readonly eventListeners = new ListenerSet<unknown>();

  private state: RealtimeSessionState = INITIAL_REALTIME_SESSION_STATE;
  private localStream: MediaStream | null = null;
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  /** Bumped on every start()/stop() so a stale async start() can detect it was superseded. */
  private generation = 0;
  /** Pending `DISCONNECT_GRACE_MS` timer started on a `'disconnected'` transition, or `null` when none is outstanding. */
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: Partial<RealtimeSessionControllerDeps> = {}, audioElement?: HTMLAudioElement) {
    this.deps = { ...defaultDeps(), ...deps };
    this.audioElement = audioElement ?? new Audio();
    this.audioElement.autoplay = true;
  }

  /** Current session state snapshot. */
  getState(): RealtimeSessionState {
    return this.state;
  }

  /** The (unmounted) element remote interpreter audio plays through. */
  getAudioElement(): HTMLAudioElement {
    return this.audioElement;
  }

  /** Subscribes to state changes; returns an unsubscribe function. Fires once immediately with the current state. */
  subscribe(listener: Listener): () => void {
    const unsubscribe = this.listeners.add(listener);
    listener(this.state);
    return unsubscribe;
  }

  /**
   * Subscribes to JSON-parsed events off the `oai-events` data channel
   * (transcription deltas, response lifecycle events, etc.) — everything
   * OpenAI sends, unfiltered. Callers (e.g. the transcript adapter) pick
   * out what they care about. Returns an unsubscribe function.
   */
  subscribeToEvents(listener: EventListener): () => void {
    return this.eventListeners.add(listener);
  }

  private setState(
    status: RealtimeSessionStatus,
    errorMessage: string | null = null,
    errorKind: RealtimeErrorKind = null,
    reconnectable = false,
  ): void {
    this.state = { status, errorMessage, errorKind, reconnectable };
    this.listeners.emit(this.state);
  }

  /**
   * Parses one data-channel message and fans it out to event subscribers.
   * A message that isn't valid JSON is dropped rather than thrown, since a
   * single malformed/truncated frame shouldn't take down the whole session.
   */
  private handleDataChannelMessage(data: string): void {
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    this.eventListeners.emit(event);
  }

  /**
   * Requests mic access, fetches an ephemeral token, and negotiates a WebRTC
   * session with OpenAI's Realtime API. A no-op while already
   * requesting/connecting/connected; call `stop()` first to retry from `'error'`.
   *
   * @param pair - Source/target language pair to negotiate for this session.
   *   Omitted entirely (rather than defaulted here) when not given, so the
   *   backend's own en -> es default is the single source of truth for it.
   */
  async start(pair?: LanguagePair): Promise<void> {
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
      connect: (stream, generation) => this.connect(stream, generation, pair),
      teardown: () => this.teardown(),
      fallbackErrorMessage: 'Failed to start the realtime session.',
    });
  }

  /**
   * The transport-specific half of {@link start}: fetches an ephemeral token
   * and negotiates the WebRTC peer connection. Shared scaffolding (mic
   * acquisition, state transitions, error classification) lives in
   * {@link runSessionStart}.
   */
  private async connect(localStream: MediaStream, myGeneration: number, pair?: LanguagePair): Promise<void> {
    const sessionInfo = await this.deps.fetchSessionInfo(pair);
    if (myGeneration !== this.generation) return;

    const peerConnection = this.deps.createPeerConnection();
    this.peerConnection = peerConnection;

    for (const track of localStream.getTracks()) {
      peerConnection.addTrack(track, localStream);
    }

    peerConnection.ontrack = (event) => {
      this.audioElement.srcObject = event.streams[0] ?? null;
    };
    // Issue #12: the only way this controller previously noticed a dead peer
    // connection was the user hitting Stop — a network drop or the remote
    // side hanging up mid-call left `status` stuck on `'connected'` forever.
    // `'failed'` means the media path is unrecoverable and is fatal
    // immediately. `'disconnected'` is a routine, often self-recovering ICE
    // blip (see `DISCONNECT_GRACE_MS`) rather than an immediate failure. A
    // transition back to `'connected'` cancels any pending grace timer.
    // `'closed'` is excluded since our own `teardown()` reaching this same
    // state is expected, not a failure to report.
    peerConnection.onconnectionstatechange = () => {
      if (myGeneration !== this.generation) return;
      const state = peerConnection.connectionState;
      if (state === 'failed') {
        this.clearDisconnectTimer();
        this.handlePostConnectFailure('The realtime connection was lost.');
      } else if (state === 'disconnected') {
        this.clearDisconnectTimer();
        this.disconnectTimer = setTimeout(() => {
          this.disconnectTimer = null;
          if (myGeneration !== this.generation) return;
          this.handlePostConnectFailure('The realtime connection was lost.');
        }, DISCONNECT_GRACE_MS);
      } else if (state === 'connected') {
        this.clearDisconnectTimer();
      }
    };

    this.dataChannel = peerConnection.createDataChannel(DATA_CHANNEL_LABEL);
    this.dataChannel.onopen = () => {
      this.dataChannel?.send(JSON.stringify(ENABLE_INPUT_TRANSCRIPTION_EVENT));
    };
    this.dataChannel.onmessage = (event: MessageEvent<string>) => this.handleDataChannelMessage(event.data);

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    if (!offer.sdp) {
      throw new Error('Failed to create a local SDP offer.');
    }

    const answerSdp = await this.deps.postOffer(offer.sdp, sessionInfo);
    if (myGeneration !== this.generation) return;

    await peerConnection.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  }

  /**
   * Transitions a live `'connected'` session to `'error'` on a post-connect
   * problem (issue #12: a WebRTC connection drop) — a no-op otherwise, e.g.
   * a late `connectionstatechange` firing after our own `stop()` already
   * tore things down. Marks the resulting state `reconnectable: true` so the
   * shared UI offers "Reconnect" (fresh `start()`, same pair, transcript
   * preserved) rather than treating this like a pre-connect failure.
   */
  private handlePostConnectFailure(message: string): void {
    if (this.state.status !== 'connected') return;
    this.teardown();
    this.setState('error', message, null, true);
  }

  /** Tears down the peer connection, data channel, and mic tracks, then returns to `'idle'`. Idempotent. */
  stop(): void {
    this.generation++;
    this.teardown();
    this.setState('idle');
  }

  /** Cancels a pending `'disconnected'` grace timer, if one is outstanding. */
  private clearDisconnectTimer(): void {
    if (this.disconnectTimer !== null) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }

  private teardown(): void {
    this.clearDisconnectTimer();
    if (this.dataChannel) {
      this.dataChannel.onopen = null;
      this.dataChannel.onmessage = null;
      this.dataChannel.close();
      this.dataChannel = null;
    }
    if (this.peerConnection) {
      this.peerConnection.onconnectionstatechange = null;
      this.peerConnection.ontrack = null;
      this.peerConnection.close();
      this.peerConnection = null;
    }
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) track.stop();
      this.localStream = null;
    }
    this.audioElement.srcObject = null;
  }
}
