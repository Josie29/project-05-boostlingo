import { createRealtimeSession, type LanguagePair, type RealtimeSessionInfo } from '../api';
import {
  INITIAL_REALTIME_SESSION_STATE,
  type RealtimeSessionState,
  type RealtimeSessionStatus,
} from './types';

const OPENAI_REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const DATA_CHANNEL_LABEL = 'oai-events';

/**
 * Client event sent over the data channel as soon as it opens, turning on
 * input audio transcription for this session. The backend's session
 * request (`backend/RealtimeSession.cs`) doesn't request this — enabling it
 * here via `session.update` is the standard client-side approach and avoids
 * a backend change for a frontend-only feature (issue #3's live transcript
 * panel needs to hear back what the *caller* said, not just the
 * interpretation).
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
  private readonly listeners = new Set<Listener>();
  private readonly eventListeners = new Set<EventListener>();

  private state: RealtimeSessionState = INITIAL_REALTIME_SESSION_STATE;
  private localStream: MediaStream | null = null;
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  /** Bumped on every start()/stop() so a stale async start() can detect it was superseded. */
  private generation = 0;

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
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Subscribes to JSON-parsed events off the `oai-events` data channel
   * (transcription deltas, response lifecycle events, etc.) — everything
   * OpenAI sends, unfiltered. Callers (e.g. the transcript adapter) pick
   * out what they care about. Returns an unsubscribe function.
   */
  subscribeToEvents(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  private setState(status: RealtimeSessionStatus, errorMessage: string | null = null): void {
    this.state = { status, errorMessage };
    for (const listener of this.listeners) listener(this.state);
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
    for (const listener of this.eventListeners) listener(event);
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
      if (myGeneration !== this.generation) return;

      this.setState('connected');
    } catch (error) {
      if (myGeneration !== this.generation) return;
      this.teardown();
      const message = error instanceof Error ? error.message : 'Failed to start the realtime session.';
      this.setState('error', message);
    }
  }

  /** Tears down the peer connection, data channel, and mic tracks, then returns to `'idle'`. Idempotent. */
  stop(): void {
    this.generation++;
    this.teardown();
    this.setState('idle');
  }

  private teardown(): void {
    if (this.dataChannel) {
      this.dataChannel.onopen = null;
      this.dataChannel.onmessage = null;
      this.dataChannel.close();
      this.dataChannel = null;
    }
    if (this.peerConnection) {
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
