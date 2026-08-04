import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CascadeSessionController } from '../cascade/CascadeSessionController';
import type { CascadeSessionControllerDeps } from '../cascade/CascadeSessionController';
import type { CascadeAudioCapture } from '../cascade/CascadeAudioCapture';

/** A fake MediaStreamTrack that records whether it was ever stopped. */
function fakeTrack(): MediaStreamTrack {
  return { stop: vi.fn(), kind: 'audio' } as unknown as MediaStreamTrack;
}

/** A fake MediaStream backed by the given tracks, mirroring the getTracks() surface the controller uses. */
function fakeStream(tracks: MediaStreamTrack[]): MediaStream {
  return { getTracks: () => tracks } as unknown as MediaStream;
}

/**
 * The surface `CascadeSessionController` actually touches on a WebSocket —
 * a standalone type (not `WebSocket & {...}`) so `readyState` stays mutable
 * here instead of inheriting the real DOM type's `readonly`. Cast to
 * `WebSocket` via {@link toWebSocket} wherever the real type is required
 * (i.e. when handed to `createWebSocket` deps).
 */
interface FakeWebSocket {
  readyState: number;
  binaryType: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: { reason: string }) => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function toWebSocket(ws: FakeWebSocket): WebSocket {
  return ws as unknown as WebSocket;
}

/**
 * A fake WebSocket covering just the surface `CascadeSessionController`
 * touches, so tests don't depend on jsdom implementing a real WebSocket
 * transport (it doesn't attempt a connection, but it also can't be driven
 * by hand the way these tests need). `close()` flips `readyState` to
 * `CLOSED`, mirroring a real socket closing synchronously enough for the
 * controller's own readyState checks.
 */
function fakeWebSocket(): FakeWebSocket {
  const ws: FakeWebSocket = {
    readyState: WebSocket.CONNECTING,
    binaryType: '',
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: vi.fn(),
    close: vi.fn(() => {
      ws.readyState = WebSocket.CLOSED;
    }),
  };
  return ws;
}

/**
 * Waits until the controller has gotten past its internal `await
 * getUserMedia(...)` and wired up `ws`'s handlers. Needed because
 * `controller.start()` suspends on that await before it ever touches the
 * socket, so driving `ws` by hand immediately after calling `start()`
 * (synchronously, in the same tick) would race ahead of the controller and
 * silently no-op on a still-null `onopen`/`onmessage`.
 */
async function waitForSocketReady(ws: FakeWebSocket): Promise<void> {
  await vi.waitFor(() => {
    if (!ws.onopen) throw new Error('Socket handlers not yet attached.');
  });
}

/** Drives `ws` through the open + session.ready handshake the controller waits on before streaming. */
function completeHandshake(ws: FakeWebSocket): void {
  ws.readyState = WebSocket.OPEN;
  ws.onopen?.();
  ws.onmessage?.({
    data: JSON.stringify({
      v: 1,
      type: 'session.ready',
      payload: { sampleRateHz: 16000, encoding: 'pcm16', channels: 1 },
    }),
  });
}

/** A fake `CascadeAudioCapture` that records start()/stop() calls and exposes the `onChunk` callback the controller passed in. */
function fakeAudioCapture() {
  let capturedOnChunk: ((chunk: ArrayBuffer) => void) | null = null;
  const capture = {
    start: vi.fn(async (_stream: MediaStream, onChunk: (chunk: ArrayBuffer) => void) => {
      capturedOnChunk = onChunk;
    }),
    stop: vi.fn(async () => {}),
  } satisfies CascadeAudioCapture;
  return {
    capture: capture as unknown as CascadeAudioCapture & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> },
    emitChunk: (chunk: ArrayBuffer) => capturedOnChunk?.(chunk),
  };
}

/** Builds a working set of deps for the happy path; individual tests override what they need. */
function buildDeps(overrides: Partial<CascadeSessionControllerDeps> = {}): CascadeSessionControllerDeps {
  return {
    getUserMedia: vi.fn(async () => fakeStream([fakeTrack()])),
    createWebSocket: vi.fn(() => toWebSocket(fakeWebSocket())),
    createAudioCapture: vi.fn(() => fakeAudioCapture().capture),
    ...overrides,
  } satisfies CascadeSessionControllerDeps;
}

describe('CascadeSessionController', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reaches "connected" on a full happy-path handshake', async () => {
    const ws = fakeWebSocket();
    const deps = buildDeps({ createWebSocket: vi.fn(() => toWebSocket(ws)) });
    const controller = new CascadeSessionController(deps);
    const states: string[] = [];
    controller.subscribe((state) => states.push(state.status));

    const startPromise = controller.start();
    await waitForSocketReady(ws);
    completeHandshake(ws);
    await startPromise;

    expect(controller.getState()).toEqual({ status: 'connected', errorMessage: null });
    expect(states).toEqual(['idle', 'requesting-mic', 'connecting', 'connected']);
  });

  it('sends session.start with the hardcoded en/es language pair once the socket opens', async () => {
    const ws = fakeWebSocket();
    const deps = buildDeps({ createWebSocket: vi.fn(() => toWebSocket(ws)) });
    const controller = new CascadeSessionController(deps);

    const startPromise = controller.start();
    await waitForSocketReady(ws);
    completeHandshake(ws);
    await startPromise;

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ v: 1, type: 'session.start', payload: { sourceLang: 'en', targetLang: 'es' } }),
    );
  });

  // Catches the bug this issue is centrally about: streaming audio before the
  // server has acknowledged the format it expects (`session.ready`). Sending
  // early risks the backend rejecting or misinterpreting frames it hasn't
  // agreed to receive yet.
  it('does not start mic capture until session.ready arrives', async () => {
    const ws = fakeWebSocket();
    const { capture } = fakeAudioCapture();
    const deps = buildDeps({ createWebSocket: vi.fn(() => toWebSocket(ws)), createAudioCapture: vi.fn(() => capture) });
    const controller = new CascadeSessionController(deps);

    const startPromise = controller.start();
    await waitForSocketReady(ws);
    ws.readyState = WebSocket.OPEN;
    ws.onopen?.();

    expect(capture.start).not.toHaveBeenCalled();

    ws.onmessage?.({
      data: JSON.stringify({ v: 1, type: 'session.ready', payload: { sampleRateHz: 16000, encoding: 'pcm16', channels: 1 } }),
    });
    await startPromise;

    expect(capture.start).toHaveBeenCalledOnce();
    expect(controller.getState().status).toBe('connected');
  });

  it('sends every chunk the audio capture produces once connected', async () => {
    const ws = fakeWebSocket();
    const { capture, emitChunk } = fakeAudioCapture();
    const deps = buildDeps({ createWebSocket: vi.fn(() => toWebSocket(ws)), createAudioCapture: vi.fn(() => capture) });
    const controller = new CascadeSessionController(deps);

    const startPromise = controller.start();
    await waitForSocketReady(ws);
    completeHandshake(ws);
    await startPromise;

    const chunk = new ArrayBuffer(4);
    emitChunk(chunk);

    expect(ws.send).toHaveBeenCalledWith(chunk);
  });

  // Catches the bug where a session.start rejected by the server (e.g. a
  // malformed payload) surfaces as a generic failure instead of the
  // server's own explanatory error message.
  it('surfaces the server error message and never starts capture if error arrives before session.ready', async () => {
    const ws = fakeWebSocket();
    const { capture } = fakeAudioCapture();
    const deps = buildDeps({ createWebSocket: vi.fn(() => toWebSocket(ws)), createAudioCapture: vi.fn(() => capture) });
    const controller = new CascadeSessionController(deps);

    const startPromise = controller.start();
    await waitForSocketReady(ws);
    ws.readyState = WebSocket.OPEN;
    ws.onopen?.();
    ws.onmessage?.({ data: JSON.stringify({ v: 1, type: 'error', payload: { message: 'Malformed session.start payload.' } }) });
    await startPromise;

    expect(controller.getState()).toEqual({ status: 'error', errorMessage: 'Malformed session.start payload.' });
    expect(capture.start).not.toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalledOnce();
  });

  // Catches the bug where an error arriving mid-session (e.g. a pipeline
  // failure in a later stage) is silently dropped because the controller
  // only ever checked for errors during the initial handshake.
  it('transitions a connected session to "error" and tears down when the server sends an error envelope', async () => {
    const ws = fakeWebSocket();
    const track = fakeTrack();
    const { capture } = fakeAudioCapture();
    const deps = buildDeps({
      getUserMedia: vi.fn(async () => fakeStream([track])),
      createWebSocket: vi.fn(() => toWebSocket(ws)),
      createAudioCapture: vi.fn(() => capture),
    });
    const controller = new CascadeSessionController(deps);

    const startPromise = controller.start();
    await waitForSocketReady(ws);
    completeHandshake(ws);
    await startPromise;

    ws.onmessage?.({ data: JSON.stringify({ v: 1, type: 'error', payload: { message: 'Pipeline error while processing audio.' } }) });

    expect(controller.getState()).toEqual({ status: 'error', errorMessage: 'Pipeline error while processing audio.' });
    expect(capture.stop).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(ws.close).toHaveBeenCalledOnce();
  });

  // Catches the core teardown bug: stop() must send session.stop, release the
  // mic, stop the audio capture, and close the socket — otherwise the mic
  // stays live (privacy issue) even after the user asks to stop.
  it('stop() sends session.stop, releases the mic and audio capture, closes the socket, then returns to idle', async () => {
    const ws = fakeWebSocket();
    const track = fakeTrack();
    const { capture } = fakeAudioCapture();
    const deps = buildDeps({
      getUserMedia: vi.fn(async () => fakeStream([track])),
      createWebSocket: vi.fn(() => toWebSocket(ws)),
      createAudioCapture: vi.fn(() => capture),
    });
    const controller = new CascadeSessionController(deps);

    const startPromise = controller.start();
    await waitForSocketReady(ws);
    completeHandshake(ws);
    await startPromise;
    expect(controller.getState().status).toBe('connected');

    controller.stop();

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ v: 1, type: 'session.stop' }));
    expect(ws.close).toHaveBeenCalledOnce();
    expect(capture.stop).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(controller.getState()).toEqual({ status: 'idle', errorMessage: null });
  });

  // Catches an accumulation bug: running start()/stop() several times in a
  // row must not pile up mic tracks, sockets, or audio capture pipelines —
  // each cycle should fully release the previous one's resources.
  it('does not accumulate resources across repeated start()/stop() cycles', async () => {
    const tracks = [fakeTrack(), fakeTrack()];
    const sockets = [fakeWebSocket(), fakeWebSocket()];
    const captures = [fakeAudioCapture(), fakeAudioCapture()];
    let call = 0;
    const deps = buildDeps({
      getUserMedia: vi.fn(async () => fakeStream([tracks[call]])),
      createWebSocket: vi.fn(() => toWebSocket(sockets[call])),
      createAudioCapture: vi.fn(() => {
        const capture = captures[call].capture;
        call++;
        return capture;
      }),
    });
    const controller = new CascadeSessionController(deps);

    const start1 = controller.start();
    await waitForSocketReady(sockets[0]);
    completeHandshake(sockets[0]);
    await start1;
    controller.stop();

    const start2 = controller.start();
    await waitForSocketReady(sockets[1]);
    completeHandshake(sockets[1]);
    await start2;
    controller.stop();

    expect(tracks[0].stop).toHaveBeenCalledOnce();
    expect(tracks[1].stop).toHaveBeenCalledOnce();
    expect(sockets[0].close).toHaveBeenCalledOnce();
    expect(sockets[1].close).toHaveBeenCalledOnce();
    expect(captures[0].capture.stop).toHaveBeenCalledOnce();
    expect(captures[1].capture.stop).toHaveBeenCalledOnce();
    expect(controller.getState()).toEqual({ status: 'idle', errorMessage: null });
  });

  // Catches a race where calling Stop while the mic permission prompt is
  // still pending (a very plausible click sequence) either leaves the
  // late-arriving mic stream running forever, or clobbers the already-idle
  // state back to "connected".
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
    const controller = new CascadeSessionController(deps);

    const startPromise = controller.start();
    controller.stop();
    resolveGetUserMedia(fakeStream([pendingTrack]));
    await startPromise;

    expect(pendingTrack.stop).toHaveBeenCalledOnce();
    expect(controller.getState()).toEqual({ status: 'idle', errorMessage: null });
  });

  // Catches a hang bug: calling stop() while the WebSocket handshake is still
  // in flight (socket created, session.ready not yet received) must not
  // leave the original start() awaiting forever — teardown() nulls out the
  // socket's event handlers, so without an explicit force-settle,
  // session.ready could never arrive to unblock it.
  it('does not hang start() when stop() is called before session.ready arrives', async () => {
    const ws = fakeWebSocket();
    const deps = buildDeps({ createWebSocket: vi.fn(() => toWebSocket(ws)) });
    const controller = new CascadeSessionController(deps);

    const startPromise = controller.start();
    await waitForSocketReady(ws);

    controller.stop();
    await startPromise;

    expect(controller.getState()).toEqual({ status: 'idle', errorMessage: null });
    expect(ws.close).toHaveBeenCalledOnce();
  });

  // Catches the bug where a mic permission denial (a common real-world case,
  // not just a theoretical one) surfaces as a generic failure instead of the
  // browser's own explanatory error (e.g. "Permission denied").
  it('surfaces the error when getUserMedia rejects', async () => {
    const deps = buildDeps({
      getUserMedia: vi.fn(async () => {
        throw new Error('Permission denied');
      }),
    });
    const controller = new CascadeSessionController(deps);

    await controller.start();

    expect(controller.getState()).toEqual({ status: 'error', errorMessage: 'Permission denied' });
  });

  // Catches a crash bug: a malformed control frame (not valid JSON) must not
  // throw out of the onmessage handler and take the whole session down.
  it('does not throw on a malformed control message and keeps waiting for a valid one', async () => {
    const ws = fakeWebSocket();
    const deps = buildDeps({ createWebSocket: vi.fn(() => toWebSocket(ws)) });
    const controller = new CascadeSessionController(deps);

    const startPromise = controller.start();
    await waitForSocketReady(ws);
    ws.readyState = WebSocket.OPEN;
    ws.onopen?.();

    expect(() => ws.onmessage?.({ data: 'not json' })).not.toThrow();
    expect(controller.getState().status).toBe('connecting');

    completeHandshake(ws);
    await startPromise;

    expect(controller.getState().status).toBe('connected');
  });
});
