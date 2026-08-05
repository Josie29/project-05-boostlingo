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
      payload: { sampleRateHz: 24000, encoding: 'pcm16', channels: 1 },
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

  // Catches the echo-cancellation regression this issue is about: without
  // explicit constraints, a browser's getUserMedia default could omit echo
  // cancellation entirely on some platforms, letting TTS output re-enter the
  // mic and self-trigger a spurious barge-in.
  it('requests the mic with explicit echo-cancellation constraints', async () => {
    const ws = fakeWebSocket();
    const getUserMedia = vi.fn(async () => fakeStream([fakeTrack()]));
    const deps = buildDeps({ createWebSocket: vi.fn(() => toWebSocket(ws)), getUserMedia });
    const controller = new CascadeSessionController(deps);

    const startPromise = controller.start();
    await waitForSocketReady(ws);
    completeHandshake(ws);
    await startPromise;

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
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

    expect(controller.getState()).toEqual({ status: 'connected', errorMessage: null, errorKind: null, reconnectable: false });
    expect(states).toEqual(['idle', 'requesting-mic', 'connecting', 'connected']);
  });

  // Confirms start() still defaults to en/es (matching the backend's own default) when
  // the caller hasn't made an explicit language selection.
  it('sends session.start with the default en/es language pair when none is given', async () => {
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

  // Catches the core wiring bug issue #8 is about: a language pair selected in the UI
  // that never reaches session.start would silently interpret en -> es no matter what
  // a listener actually picked (e.g. swapping to es -> en would be a no-op).
  it('sends session.start with the given language pair once the socket opens', async () => {
    const ws = fakeWebSocket();
    const deps = buildDeps({ createWebSocket: vi.fn(() => toWebSocket(ws)) });
    const controller = new CascadeSessionController(deps);

    const startPromise = controller.start({ sourceLang: 'es', targetLang: 'en' });
    await waitForSocketReady(ws);
    completeHandshake(ws);
    await startPromise;

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ v: 1, type: 'session.start', payload: { sourceLang: 'es', targetLang: 'en' } }),
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
      data: JSON.stringify({ v: 1, type: 'session.ready', payload: { sampleRateHz: 24000, encoding: 'pcm16', channels: 1 } }),
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

    expect(controller.getState()).toEqual({
      status: 'error',
      errorMessage: 'Malformed session.start payload.',
      errorKind: null,
      reconnectable: false,
    });
    expect(capture.start).not.toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalledOnce();
  });

  // Catches the bug where an unrecoverable error arriving mid-session (issue
  // #12: `recoverable: false` — a stage, or the session itself, is now dead
  // for good, e.g. STT's one reopen attempt also failed) is silently dropped
  // because the controller only ever checked for errors during the initial
  // handshake. `reconnectable: true` on the resulting state is what drives
  // the shared UI's Reconnect affordance rather than a plain retry.
  it('transitions a connected session to "error" (reconnectable) and tears down on an unrecoverable error envelope', async () => {
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

    ws.onmessage?.({
      data: JSON.stringify({
        v: 1,
        type: 'error',
        payload: { message: "STT's stream died and could not be reopened.", stage: 'session', utteranceId: null, recoverable: false },
      }),
    });

    expect(controller.getState()).toEqual({
      status: 'error',
      errorMessage: "STT's stream died and could not be reopened.",
      errorKind: null,
      reconnectable: true,
    });
    expect(capture.stop).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(ws.close).toHaveBeenCalledOnce();
  });

  // Catches the core issue #12 regression this feature guards against: a
  // *recoverable* per-stage failure (one utterance's MT request failed, say)
  // must NOT tear the session down the way the unrecoverable case above
  // does — the whole point of the recoverable/unrecoverable split is that
  // the caller keeps talking uninterrupted through a one-off hiccup.
  it('stays connected on a recoverable error envelope and fans it out as a notice instead of tearing down', async () => {
    const ws = fakeWebSocket();
    const track = fakeTrack();
    const { capture } = fakeAudioCapture();
    const deps = buildDeps({
      getUserMedia: vi.fn(async () => fakeStream([track])),
      createWebSocket: vi.fn(() => toWebSocket(ws)),
      createAudioCapture: vi.fn(() => capture),
    });
    const controller = new CascadeSessionController(deps);
    const notices: unknown[] = [];
    controller.subscribeToNotice((notice) => notices.push(notice));

    const startPromise = controller.start();
    await waitForSocketReady(ws);
    completeHandshake(ws);
    await startPromise;

    ws.onmessage?.({
      data: JSON.stringify({
        v: 1,
        type: 'error',
        payload: { message: 'Machine translation failed for one utterance.', stage: 'mt', utteranceId: 'utt_1', recoverable: true },
      }),
    });

    expect(controller.getState()).toEqual({ status: 'connected', errorMessage: null, errorKind: null, reconnectable: false });
    expect(capture.stop).not.toHaveBeenCalled();
    expect(track.stop).not.toHaveBeenCalled();
    expect(notices).toEqual([{ message: 'Machine translation failed for one utterance.', utteranceId: 'utt_1' }]);
  });

  // Catches a defensiveness regression: a payload missing `recoverable`
  // altogether (any pre-#12 server build, however unlikely alongside this
  // frontend) must default to the non-fatal notice path, not silently drop
  // the session — the safer failure mode when the field's meaning is unknown.
  it('treats an error envelope with no `recoverable` field as a non-fatal notice', async () => {
    const ws = fakeWebSocket();
    const deps = buildDeps({ createWebSocket: vi.fn(() => toWebSocket(ws)) });
    const controller = new CascadeSessionController(deps);
    const notices: unknown[] = [];
    controller.subscribeToNotice((notice) => notices.push(notice));

    const startPromise = controller.start();
    await waitForSocketReady(ws);
    completeHandshake(ws);
    await startPromise;

    ws.onmessage?.({ data: JSON.stringify({ v: 1, type: 'error', payload: { message: 'Pipeline error while processing audio.' } }) });

    expect(controller.getState().status).toBe('connected');
    expect(notices).toEqual([{ message: 'Pipeline error while processing audio.', utteranceId: null }]);
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
    expect(controller.getState()).toEqual({ status: 'idle', errorMessage: null, errorKind: null, reconnectable: false });
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
    expect(controller.getState()).toEqual({ status: 'idle', errorMessage: null, errorKind: null, reconnectable: false });
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
    expect(controller.getState()).toEqual({ status: 'idle', errorMessage: null, errorKind: null, reconnectable: false });
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

    expect(controller.getState()).toEqual({ status: 'idle', errorMessage: null, errorKind: null, reconnectable: false });
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

    expect(controller.getState()).toEqual({
      status: 'error',
      errorMessage: 'Permission denied',
      errorKind: null,
      reconnectable: false,
    });
  });

  // Catches the bug this issue (#12) is about: a mic permission denial (an
  // everyday real-world case, not a theoretical one) surfacing as the same
  // undifferentiated error as any other failure, instead of the distinct
  // "here's how to fix it" guidance the shared UI renders off `errorKind`.
  it('classifies a NotAllowedError from getUserMedia as "mic-denied"', async () => {
    const deps = buildDeps({
      getUserMedia: vi.fn(async () => {
        throw new DOMException('Permission denied', 'NotAllowedError');
      }),
    });
    const controller = new CascadeSessionController(deps);

    await controller.start();

    const state = controller.getState();
    expect(state.status).toBe('error');
    expect(state.errorKind).toBe('mic-denied');
    expect(state.reconnectable).toBe(false);
  });

  // Catches the sibling classification bug: "no mic exists" needs its own
  // guidance (connect a mic), distinct from "you denied the permission
  // prompt" (change a browser setting) — conflating the two would send a
  // listener down the wrong troubleshooting path.
  it('classifies a NotFoundError from getUserMedia as "mic-not-found"', async () => {
    const deps = buildDeps({
      getUserMedia: vi.fn(async () => {
        throw new DOMException('No microphone found', 'NotFoundError');
      }),
    });
    const controller = new CascadeSessionController(deps);

    await controller.start();

    const state = controller.getState();
    expect(state.status).toBe('error');
    expect(state.errorKind).toBe('mic-not-found');
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

  // Catches the bug where transcript adapters never see any events because the
  // controller parses control frames internally but forgets to fan them out to
  // subscribers — the transcript panel's source column would stay empty forever.
  it('forwards every parsed envelope, including transcript events, to event subscribers', async () => {
    const ws = fakeWebSocket();
    const deps = buildDeps({ createWebSocket: vi.fn(() => toWebSocket(ws)) });
    const controller = new CascadeSessionController(deps);
    const events: unknown[] = [];
    controller.subscribeToEvents((event) => events.push(event));

    const startPromise = controller.start();
    await waitForSocketReady(ws);
    completeHandshake(ws);
    await startPromise;

    const transcriptEnvelope = {
      v: 1,
      type: 'transcript.partial',
      payload: { utteranceId: 'utt_1', lane: 'source', text: 'Hel', timestampMs: 120 },
    };
    ws.onmessage?.({ data: JSON.stringify(transcriptEnvelope) });

    expect(events).toContainEqual(transcriptEnvelope);
    // The session.ready control frame from the handshake is fanned out too, since the
    // controller forwards everything unfiltered and lets subscribers pick out what
    // they care about (mirroring RealtimeSessionController.subscribeToEvents).
    expect(events).toContainEqual({
      v: 1,
      type: 'session.ready',
      payload: { sampleRateHz: 24000, encoding: 'pcm16', channels: 1 },
    });
  });

  // Catches a crash bug: a malformed control frame (not valid JSON) must not throw
  // out of the onmessage handler or notify subscribers with garbage.
  it('does not notify event subscribers when a message is malformed', async () => {
    const ws = fakeWebSocket();
    const deps = buildDeps({ createWebSocket: vi.fn(() => toWebSocket(ws)) });
    const controller = new CascadeSessionController(deps);
    const events: unknown[] = [];
    controller.subscribeToEvents((event) => events.push(event));

    const startPromise = controller.start();
    await waitForSocketReady(ws);
    ws.readyState = WebSocket.OPEN;
    ws.onopen?.();

    expect(() => ws.onmessage?.({ data: 'not json' })).not.toThrow();
    expect(events).toEqual([]);

    completeHandshake(ws);
    await startPromise;
  });
});

describe('CascadeSessionController TTS audio framing (issue #7)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // Catches the central framing bug this issue is about: a binary frame is
  // just raw bytes with no utteranceId of its own, so if the controller
  // didn't track which tts.audio.start/tts.audio.end window it's inside,
  // audio would either be silently lost or (worse) attributed to the wrong
  // utterance's playback.
  it('routes a binary frame between tts.audio.start and tts.audio.end to audio subscribers, tagged with that utteranceId', async () => {
    const ws = fakeWebSocket();
    const deps = buildDeps({ createWebSocket: vi.fn(() => toWebSocket(ws)) });
    const controller = new CascadeSessionController(deps);
    const events: unknown[] = [];
    controller.subscribeToAudio((event) => events.push(event));

    const startPromise = controller.start();
    await waitForSocketReady(ws);
    completeHandshake(ws);
    await startPromise;

    ws.onmessage?.({
      data: JSON.stringify({
        v: 1,
        type: 'tts.audio.start',
        payload: { utteranceId: 'utt-1-target', sampleRateHz: 24000, encoding: 'pcm16', channels: 1 },
      }),
    });
    const chunk = new ArrayBuffer(4);
    ws.onmessage?.({ data: chunk });
    ws.onmessage?.({ data: JSON.stringify({ v: 1, type: 'tts.audio.end', payload: { utteranceId: 'utt-1-target' } }) });

    expect(events).toEqual([
      { kind: 'start', utteranceId: 'utt-1-target', sampleRateHz: 24000 },
      { kind: 'chunk', utteranceId: 'utt-1-target', data: chunk },
      { kind: 'end', utteranceId: 'utt-1-target' },
    ]);
  });

  // Catches a silent-audio-corruption bug: a binary frame that arrives
  // outside any tts.audio.start/tts.audio.end window (e.g. a bug elsewhere
  // sends one prematurely, or one arrives after teardown raced the socket
  // closing) has no utteranceId to attribute it to. Playing or queuing it
  // anyway risks stitching unrelated audio into whatever utterance happens
  // to play next; dropping it (with a warning, so the bug is visible in the
  // console rather than invisible) is the safe behavior.
  it('drops a binary frame received outside any tts.audio.start/tts.audio.end window and warns', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ws = fakeWebSocket();
    const deps = buildDeps({ createWebSocket: vi.fn(() => toWebSocket(ws)) });
    const controller = new CascadeSessionController(deps);
    const events: unknown[] = [];
    controller.subscribeToAudio((event) => events.push(event));

    const startPromise = controller.start();
    await waitForSocketReady(ws);
    completeHandshake(ws);
    await startPromise;

    ws.onmessage?.({ data: new ArrayBuffer(4) });

    expect(events).toEqual([]);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  // Catches a cross-utterance leakage bug: once tts.audio.end closes a
  // window, a later binary frame must not still be attributed to that
  // now-closed utteranceId — otherwise a stray frame after `end` (arriving
  // late, or from a bug elsewhere) would get queued as if it were still
  // part of an utterance whose playback the queue may have already
  // finished scheduling.
  it('stops attributing binary frames to an utterance once its tts.audio.end arrives', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ws = fakeWebSocket();
    const deps = buildDeps({ createWebSocket: vi.fn(() => toWebSocket(ws)) });
    const controller = new CascadeSessionController(deps);
    const events: unknown[] = [];
    controller.subscribeToAudio((event) => events.push(event));

    const startPromise = controller.start();
    await waitForSocketReady(ws);
    completeHandshake(ws);
    await startPromise;

    ws.onmessage?.({
      data: JSON.stringify({ v: 1, type: 'tts.audio.start', payload: { utteranceId: 'utt-1', sampleRateHz: 24000, encoding: 'pcm16', channels: 1 } }),
    });
    ws.onmessage?.({ data: JSON.stringify({ v: 1, type: 'tts.audio.end', payload: { utteranceId: 'utt-1' } }) });
    ws.onmessage?.({ data: new ArrayBuffer(4) }); // arrives after the window closed

    expect(events.filter((event) => (event as { kind: string }).kind === 'chunk')).toEqual([]);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  // Catches a mis-association bug specific to sequential utterances: since
  // the wire format's binary frames carry no utteranceId of their own, the
  // controller must correctly re-associate frames with the *second*
  // utterance's id once its own tts.audio.start arrives — a state machine
  // that only ever remembered the first utteranceId it saw would silently
  // mislabel every subsequent utterance's audio.
  it('correctly re-associates frames with a second utterance after the first one ends', async () => {
    const ws = fakeWebSocket();
    const deps = buildDeps({ createWebSocket: vi.fn(() => toWebSocket(ws)) });
    const controller = new CascadeSessionController(deps);
    const events: unknown[] = [];
    controller.subscribeToAudio((event) => events.push(event));

    const startPromise = controller.start();
    await waitForSocketReady(ws);
    completeHandshake(ws);
    await startPromise;

    const chunk1 = new ArrayBuffer(4);
    const chunk2 = new ArrayBuffer(8);
    ws.onmessage?.({ data: JSON.stringify({ v: 1, type: 'tts.audio.start', payload: { utteranceId: 'utt-1', sampleRateHz: 24000, encoding: 'pcm16', channels: 1 } }) });
    ws.onmessage?.({ data: chunk1 });
    ws.onmessage?.({ data: JSON.stringify({ v: 1, type: 'tts.audio.end', payload: { utteranceId: 'utt-1' } }) });
    ws.onmessage?.({ data: JSON.stringify({ v: 1, type: 'tts.audio.start', payload: { utteranceId: 'utt-2', sampleRateHz: 24000, encoding: 'pcm16', channels: 1 } }) });
    ws.onmessage?.({ data: chunk2 });

    const chunkEvents = events.filter((event) => (event as { kind: string }).kind === 'chunk');
    expect(chunkEvents).toEqual([
      { kind: 'chunk', utteranceId: 'utt-1', data: chunk1 },
      { kind: 'chunk', utteranceId: 'utt-2', data: chunk2 },
    ]);
  });

  // Catches a resource-leak/mislabeling bug across sessions: if a new
  // session started right after an old one's tts.audio.start (with no
  // matching end — e.g. the session was torn down mid-utterance) didn't
  // reset the audio window, a stray binary frame early in the *new* session
  // could be misattributed to a stale utteranceId from the old one.
  it('clears the current audio-utterance window on teardown, so a stray frame early in the next session is dropped rather than misattributed to the old utteranceId', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sockets = [fakeWebSocket(), fakeWebSocket()];
    let call = 0;
    const deps = buildDeps({ createWebSocket: vi.fn(() => toWebSocket(sockets[call++])) });
    const controller = new CascadeSessionController(deps);
    const events: unknown[] = [];
    controller.subscribeToAudio((event) => events.push(event));

    const start1 = controller.start();
    await waitForSocketReady(sockets[0]);
    completeHandshake(sockets[0]);
    await start1;

    sockets[0].onmessage?.({
      data: JSON.stringify({ v: 1, type: 'tts.audio.start', payload: { utteranceId: 'utt-1', sampleRateHz: 24000, encoding: 'pcm16', channels: 1 } }),
    });
    controller.stop(); // torn down mid-utterance, no tts.audio.end ever arrived

    const start2 = controller.start();
    await waitForSocketReady(sockets[1]);
    completeHandshake(sockets[1]);
    await start2;

    // A binary frame arriving early in the new session, before its own
    // tts.audio.start, must not still be attributed to the previous
    // session's 'utt-1' — a state machine that didn't reset on teardown
    // would silently mislabel it.
    sockets[1].onmessage?.({ data: new ArrayBuffer(4) });

    expect(events.filter((event) => (event as { kind: string }).kind === 'chunk')).toEqual([]);
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});

describe('CascadeSessionController barge-in (issue #11)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // Catches the core plumbing bug this issue is about: if a bargein envelope
  // never reached audio subscribers, `AudioPlaybackQueue` would have no way
  // to know a barge-in happened at all, and superseded audio would keep
  // playing.
  it('emits a bargein CascadeAudioEvent to audio subscribers when the envelope names superseded ids', async () => {
    const ws = fakeWebSocket();
    const deps = buildDeps({ createWebSocket: vi.fn(() => toWebSocket(ws)) });
    const controller = new CascadeSessionController(deps);
    const events: unknown[] = [];
    controller.subscribeToAudio((event) => events.push(event));

    const startPromise = controller.start();
    await waitForSocketReady(ws);
    completeHandshake(ws);
    await startPromise;

    ws.onmessage?.({
      data: JSON.stringify({
        v: 1,
        type: 'bargein',
        payload: { supersededUtteranceIds: ['utt-1-target', 'utt-2-target'], serverTimeMs: 1_000 },
      }),
    });

    expect(events).toEqual([
      { kind: 'bargein', supersededUtteranceIds: ['utt-1-target', 'utt-2-target'] },
    ]);
  });

  // Catches the known benign race the backend flags explicitly: a barged-in
  // utterance's tts.audio.end may never arrive at all, since synthesis was
  // aborted mid-stream. Without closing the window on bargein itself, every
  // future binary frame (belonging to whatever utterance starts next) would
  // keep being silently misattributed to this now-superseded id forever.
  it('closes the currently-open audio window when its utteranceId is superseded, so later frames are dropped rather than misattributed', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ws = fakeWebSocket();
    const deps = buildDeps({ createWebSocket: vi.fn(() => toWebSocket(ws)) });
    const controller = new CascadeSessionController(deps);
    const events: unknown[] = [];
    controller.subscribeToAudio((event) => events.push(event));

    const startPromise = controller.start();
    await waitForSocketReady(ws);
    completeHandshake(ws);
    await startPromise;

    ws.onmessage?.({
      data: JSON.stringify({
        v: 1,
        type: 'tts.audio.start',
        payload: { utteranceId: 'utt-1-target', sampleRateHz: 24000, encoding: 'pcm16', channels: 1 },
      }),
    });
    // No tts.audio.end for utt-1-target — it never arrives, per the known race.
    ws.onmessage?.({
      data: JSON.stringify({
        v: 1,
        type: 'bargein',
        payload: { supersededUtteranceIds: ['utt-1-target'], serverTimeMs: 1_000 },
      }),
    });
    ws.onmessage?.({ data: new ArrayBuffer(4) }); // a late frame, arriving after the barge-in

    const chunkEvents = events.filter((event) => (event as { kind: string }).kind === 'chunk');
    expect(chunkEvents).toEqual([]);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  // Catches an over-eager-close bug: a bargein naming ids unrelated to
  // whatever audio window is currently open must not close that unrelated
  // window — only the utterance actually named as superseded should be
  // affected.
  it('leaves an open audio window alone when the bargein does not name its utteranceId', async () => {
    const ws = fakeWebSocket();
    const deps = buildDeps({ createWebSocket: vi.fn(() => toWebSocket(ws)) });
    const controller = new CascadeSessionController(deps);
    const events: unknown[] = [];
    controller.subscribeToAudio((event) => events.push(event));

    const startPromise = controller.start();
    await waitForSocketReady(ws);
    completeHandshake(ws);
    await startPromise;

    ws.onmessage?.({
      data: JSON.stringify({
        v: 1,
        type: 'tts.audio.start',
        payload: { utteranceId: 'utt-1-target', sampleRateHz: 24000, encoding: 'pcm16', channels: 1 },
      }),
    });
    ws.onmessage?.({
      data: JSON.stringify({
        v: 1,
        type: 'bargein',
        payload: { supersededUtteranceIds: ['some-other-utterance'], serverTimeMs: 1_000 },
      }),
    });
    const chunk = new ArrayBuffer(4);
    ws.onmessage?.({ data: chunk }); // still inside utt-1-target's window

    const chunkEvents = events.filter((event) => (event as { kind: string }).kind === 'chunk');
    expect(chunkEvents).toEqual([{ kind: 'chunk', utteranceId: 'utt-1-target', data: chunk }]);
  });

  // Catches the bug the backend's contract explicitly calls out: a bargein
  // envelope is only ever sent with a non-empty supersededUtteranceIds, but
  // defensively, an empty (or malformed) one must not fan out a bogus
  // "nothing superseded" event that would confuse the playback queue.
  it('does not emit a bargein event when supersededUtteranceIds is empty', async () => {
    const ws = fakeWebSocket();
    const deps = buildDeps({ createWebSocket: vi.fn(() => toWebSocket(ws)) });
    const controller = new CascadeSessionController(deps);
    const events: unknown[] = [];
    controller.subscribeToAudio((event) => events.push(event));

    const startPromise = controller.start();
    await waitForSocketReady(ws);
    completeHandshake(ws);
    await startPromise;

    ws.onmessage?.({
      data: JSON.stringify({ v: 1, type: 'bargein', payload: { supersededUtteranceIds: [], serverTimeMs: 1_000 } }),
    });

    expect(events).toEqual([]);
  });
});
