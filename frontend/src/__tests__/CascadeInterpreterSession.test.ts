import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioPlaybackQueue } from '../cascade/AudioPlaybackQueue';
import { CascadeSessionController } from '../cascade/CascadeSessionController';
import type { CascadeSessionControllerDeps } from '../cascade/CascadeSessionController';
import type { CascadeAudioCapture } from '../cascade/CascadeAudioCapture';
import { CascadeInterpreterSession } from '../session/CascadeInterpreterSession';

function fakeTrack(): MediaStreamTrack {
  return { stop: vi.fn(), kind: 'audio' } as unknown as MediaStreamTrack;
}

function fakeStream(): MediaStream {
  return { getTracks: () => [fakeTrack()] } as unknown as MediaStream;
}

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

/** Waits until the controller has gotten past `await getUserMedia(...)` and wired up `ws`'s handlers. */
async function waitForSocketReady(ws: FakeWebSocket): Promise<void> {
  await vi.waitFor(() => {
    if (!ws.onopen) throw new Error('Socket handlers not yet attached.');
  });
}

function completeHandshake(ws: FakeWebSocket): void {
  ws.readyState = WebSocket.OPEN;
  ws.onopen?.();
  ws.onmessage?.({
    data: JSON.stringify({ v: 1, type: 'session.ready', payload: { sampleRateHz: 16000, encoding: 'pcm16', channels: 1 } }),
  });
}

function fakeAudioCapture(): CascadeAudioCapture {
  return { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
}

function buildControllerDeps(overrides: Partial<CascadeSessionControllerDeps> = {}): CascadeSessionControllerDeps {
  return {
    getUserMedia: vi.fn(async () => fakeStream()),
    createWebSocket: vi.fn(() => toWebSocket(fakeWebSocket())),
    createAudioCapture: vi.fn(() => fakeAudioCapture()),
    ...overrides,
  };
}

/** A no-op AudioContext stub so `AudioPlaybackQueue.stop()` doesn't need jsdom's (absent) Web Audio API. */
function fakeAudioContext(): AudioContext {
  return { close: vi.fn(async () => {}) } as unknown as AudioContext;
}

describe('CascadeInterpreterSession', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reports mode "cascade" and delegates state/start/stop to the underlying controller', async () => {
    const ws = fakeWebSocket();
    const controller = new CascadeSessionController(buildControllerDeps({ createWebSocket: () => toWebSocket(ws) }));
    const playbackQueue = new AudioPlaybackQueue({ createAudioContext: fakeAudioContext });
    const session = new CascadeInterpreterSession(controller, playbackQueue);

    expect(session.mode).toBe('cascade');

    const startPromise = session.start({ sourceLang: 'en', targetLang: 'es' });
    await waitForSocketReady(ws);
    completeHandshake(ws);
    await startPromise;

    expect(controller.getState().status).toBe('connected');
    expect(session.getState()).toEqual(controller.getState());

    session.stop();
    expect(controller.getState().status).toBe('idle');
  });

  // Catches the cross-transport collision bug (see InterpreterSession.test.ts):
  // if this adapter forwarded the raw utteranceId unprefixed, a Cascade utterance
  // could collide with a Realtime one in the shared transcript kept across a mode
  // switch.
  it('prefixes transcript utteranceIds with "cascade:" before notifying subscribers', async () => {
    const ws = fakeWebSocket();
    const controller = new CascadeSessionController(buildControllerDeps({ createWebSocket: () => toWebSocket(ws) }));
    const session = new CascadeInterpreterSession(controller, new AudioPlaybackQueue({ createAudioContext: fakeAudioContext }));
    const updates: unknown[] = [];
    session.subscribeToTranscript((update) => updates.push(update));

    const startPromise = session.start({ sourceLang: 'en', targetLang: 'es' });
    await waitForSocketReady(ws);
    completeHandshake(ws);
    await startPromise;

    ws.onmessage?.({
      data: JSON.stringify({
        v: 1,
        type: 'transcript.partial',
        payload: { utteranceId: 'item_1', lane: 'source', text: 'Hola', timestampMs: 0 },
      }),
    });

    expect(updates).toEqual([{ utteranceId: 'cascade:item_1', lane: 'source', text: 'Hola', final: false }]);
  });

  // Catches a leak where switching away from Cascade mid-utterance leaves TTS audio
  // scheduled to keep playing (or its AudioContext open) even though the session
  // it belonged to was torn down.
  it('stops the audio playback queue alongside the controller on stop()', async () => {
    const ws = fakeWebSocket();
    const controller = new CascadeSessionController(buildControllerDeps({ createWebSocket: () => toWebSocket(ws) }));
    const playbackQueue = new AudioPlaybackQueue({ createAudioContext: fakeAudioContext });
    const stopSpy = vi.spyOn(playbackQueue, 'stop');
    const session = new CascadeInterpreterSession(controller, playbackQueue);

    const startPromise = session.start({ sourceLang: 'en', targetLang: 'es' });
    await waitForSocketReady(ws);
    completeHandshake(ws);
    await startPromise;

    session.stop();

    expect(stopSpy).toHaveBeenCalledOnce();
  });
});
