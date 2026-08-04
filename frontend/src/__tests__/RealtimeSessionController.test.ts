import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeSessionController } from '../realtime/RealtimeSessionController';
import type { RealtimeSessionControllerDeps } from '../realtime/RealtimeSessionController';
import type { RealtimeSessionInfo } from '../api';

const SESSION_INFO: RealtimeSessionInfo = {
  clientSecret: 'ek_test_123',
  expiresAt: 1234567890,
  model: 'gpt-realtime',
};

/** A fake MediaStreamTrack that records whether it was ever stopped. */
function fakeTrack(): MediaStreamTrack {
  return { stop: vi.fn(), kind: 'audio' } as unknown as MediaStreamTrack;
}

/** A fake MediaStream backed by the given tracks, mirroring the getTracks() surface the controller uses. */
function fakeStream(tracks: MediaStreamTrack[]): MediaStream {
  return { getTracks: () => tracks } as unknown as MediaStream;
}

/** A fake RTCDataChannel that records whether close() was called. */
function fakeDataChannel(): RTCDataChannel {
  return { close: vi.fn() } as unknown as RTCDataChannel;
}

/**
 * A fake RTCPeerConnection covering just the surface RealtimeSessionController
 * touches, so tests don't depend on jsdom implementing real WebRTC (it doesn't).
 */
function fakePeerConnection() {
  const dataChannel = fakeDataChannel();
  const pc = {
    ontrack: null as ((event: { streams: MediaStream[] }) => void) | null,
    addTrack: vi.fn(),
    createDataChannel: vi.fn(() => dataChannel),
    createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'fake-offer-sdp' })),
    setLocalDescription: vi.fn(async () => {}),
    setRemoteDescription: vi.fn(async () => {}),
    close: vi.fn(),
  };
  return { pc: pc as unknown as RTCPeerConnection, dataChannel, raw: pc };
}

/** Builds a working set of deps for the happy path; individual tests override what they need. */
function buildDeps(overrides: Partial<RealtimeSessionControllerDeps> = {}) {
  return {
    fetchSessionInfo: vi.fn(async () => SESSION_INFO),
    getUserMedia: vi.fn(async () => fakeStream([fakeTrack()])),
    createPeerConnection: vi.fn(() => fakePeerConnection().pc),
    postOffer: vi.fn(async () => 'fake-answer-sdp'),
    ...overrides,
  } satisfies RealtimeSessionControllerDeps;
}

describe('RealtimeSessionController', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reaches "connected" on a full happy-path negotiation', async () => {
    const deps = buildDeps();
    const controller = new RealtimeSessionController(deps);
    const states: string[] = [];
    controller.subscribe((state) => states.push(state.status));

    await controller.start();

    expect(controller.getState()).toEqual({ status: 'connected', errorMessage: null });
    // Order matters: the UI should see every intermediate state, not just the final one.
    expect(states).toEqual(['idle', 'requesting-mic', 'connecting', 'connected']);
  });

  // Catches the bug where a 503 (missing OPENAI_API_KEY on the server) surfaces
  // as a generic failure instead of the backend's own explanatory message —
  // a parent/operator needs to know *why*, not just that it failed.
  it('surfaces the backend error message when token fetch fails (e.g. 503)', async () => {
    const deps = buildDeps({
      fetchSessionInfo: vi.fn(async () => {
        throw new Error('The server is not configured with an OpenAI API key.');
      }),
    });
    const controller = new RealtimeSessionController(deps);

    await controller.start();

    expect(controller.getState()).toEqual({
      status: 'error',
      errorMessage: 'The server is not configured with an OpenAI API key.',
    });
  });

  // Catches a leak where the mic stays live after a mid-flight failure (e.g. OpenAI's
  // /calls endpoint rejecting the offer) — the browser's mic indicator would stay on
  // forever even though the session never actually connected.
  it('stops mic tracks if negotiation fails after the mic was already captured', async () => {
    const track = fakeTrack();
    const deps = buildDeps({
      getUserMedia: vi.fn(async () => fakeStream([track])),
      postOffer: vi.fn(async () => {
        throw new Error('OpenAI Realtime call setup failed (status 401)');
      }),
    });
    const controller = new RealtimeSessionController(deps);

    await controller.start();

    expect(controller.getState().status).toBe('error');
    expect(track.stop).toHaveBeenCalledOnce();
  });

  // Catches the core teardown bug: stop() must release the mic, close the data
  // channel, and close the peer connection — otherwise the mic stays live (privacy
  // issue) and connections pile up across sessions.
  it('stop() releases the mic, data channel, and peer connection, then returns to idle', async () => {
    const track = fakeTrack();
    const { pc, dataChannel } = fakePeerConnection();
    const deps = buildDeps({
      getUserMedia: vi.fn(async () => fakeStream([track])),
      createPeerConnection: vi.fn(() => pc),
    });
    const controller = new RealtimeSessionController(deps);
    await controller.start();
    expect(controller.getState().status).toBe('connected');

    controller.stop();

    expect(track.stop).toHaveBeenCalledOnce();
    expect(dataChannel.close).toHaveBeenCalledOnce();
    expect(pc.close).toHaveBeenCalledOnce();
    expect(controller.getState()).toEqual({ status: 'idle', errorMessage: null });
  });

  // Catches an accumulation bug: running start()/stop() several times in a row
  // (a user hitting Start/Stop repeatedly) must not pile up mic tracks, data
  // channels, peer connections, or extra <audio> elements — each cycle should
  // fully release the previous one's resources.
  it('does not accumulate resources across repeated start()/stop() cycles', async () => {
    const tracks = [fakeTrack(), fakeTrack()];
    const connections = [fakePeerConnection(), fakePeerConnection()];
    let call = 0;
    const deps = buildDeps({
      getUserMedia: vi.fn(async () => fakeStream([tracks[call]])),
      createPeerConnection: vi.fn(() => connections[call++].pc),
    });
    const controller = new RealtimeSessionController(deps);
    const audioElement = controller.getAudioElement();

    await controller.start();
    controller.stop();
    await controller.start();
    controller.stop();

    expect(tracks[0].stop).toHaveBeenCalledOnce();
    expect(tracks[1].stop).toHaveBeenCalledOnce();
    expect(connections[0].raw.close).toHaveBeenCalledOnce();
    expect(connections[1].raw.close).toHaveBeenCalledOnce();
    // Same controller reuses one audio element across cycles rather than creating new ones.
    expect(controller.getAudioElement()).toBe(audioElement);
    expect(controller.getState()).toEqual({ status: 'idle', errorMessage: null });
  });

  // Catches a race where calling Stop while the mic permission prompt is still
  // pending (a very plausible click sequence for an impatient user) either
  // leaves the late-arriving mic stream running forever, or clobbers the
  // already-idle state back to "connected".
  it('discards a mic stream that resolves after stop() was called mid-request', async () => {
    let resolveGetUserMedia!: (stream: MediaStream) => void;
    const pendingTrack = fakeTrack();
    const deps = buildDeps({
      getUserMedia: vi.fn(
        () =>
          new Promise<MediaStream>((resolve) => {
            resolveGetUserMedia = resolve;
          }),
      ),
    });
    const controller = new RealtimeSessionController(deps);

    const startPromise = controller.start();
    controller.stop();
    resolveGetUserMedia(fakeStream([pendingTrack]));
    await startPromise;

    expect(pendingTrack.stop).toHaveBeenCalledOnce();
    expect(controller.getState()).toEqual({ status: 'idle', errorMessage: null });
  });

  it('opens an "oai-events" data channel during negotiation', async () => {
    const { pc, raw } = fakePeerConnection();
    const deps = buildDeps({ createPeerConnection: vi.fn(() => pc) });
    const controller = new RealtimeSessionController(deps);

    await controller.start();

    expect(raw.createDataChannel).toHaveBeenCalledWith('oai-events');
  });

  it('routes the remote track onto the internal audio element', async () => {
    const { pc, raw } = fakePeerConnection();
    const deps = buildDeps({ createPeerConnection: vi.fn(() => pc) });
    const controller = new RealtimeSessionController(deps);
    const remoteStream = fakeStream([fakeTrack()]);

    await controller.start();
    raw.ontrack?.({ streams: [remoteStream] });

    expect(controller.getAudioElement().srcObject).toBe(remoteStream);
  });
});
