import { describe, expect, it } from 'vitest';
import { RealtimeSessionController } from '../realtime/RealtimeSessionController';
import type { RealtimeSessionControllerDeps } from '../realtime/RealtimeSessionController';
import { RealtimeInterpreterSession } from '../session/RealtimeInterpreterSession';
import type { RealtimeSessionInfo } from '../api';

const SESSION_INFO: RealtimeSessionInfo = {
  clientSecret: 'ek_test_123',
  expiresAt: 1234567890,
  model: 'gpt-realtime',
};

function fakeTrack(): MediaStreamTrack {
  return { stop: () => {}, kind: 'audio' } as unknown as MediaStreamTrack;
}

function fakeStream(): MediaStream {
  return { getTracks: () => [fakeTrack()] } as unknown as MediaStream;
}

function fakeDataChannel() {
  return {
    close: () => {},
    send: () => {},
    onopen: null,
    onmessage: null as ((event: { data: string }) => void) | null,
  } as unknown as RTCDataChannel & { onmessage: ((event: { data: string }) => void) | null };
}

function fakePeerConnection() {
  const dataChannel = fakeDataChannel();
  const pc = {
    ontrack: null,
    addTrack: () => {},
    createDataChannel: () => dataChannel,
    createOffer: async () => ({ type: 'offer', sdp: 'fake-offer-sdp' }),
    setLocalDescription: async () => {},
    setRemoteDescription: async () => {},
    close: () => {},
  };
  return { pc: pc as unknown as RTCPeerConnection, dataChannel };
}

function buildDeps(overrides: Partial<RealtimeSessionControllerDeps> = {}): RealtimeSessionControllerDeps {
  return {
    fetchSessionInfo: async () => SESSION_INFO,
    getUserMedia: async () => fakeStream(),
    createPeerConnection: () => fakePeerConnection().pc,
    postOffer: async () => 'fake-answer-sdp',
    ...overrides,
  };
}

describe('RealtimeInterpreterSession', () => {
  it('reports mode "realtime" and delegates state/start/stop to the underlying controller', async () => {
    const controller = new RealtimeSessionController(buildDeps());
    const session = new RealtimeInterpreterSession(controller);

    expect(session.mode).toBe('realtime');
    expect(session.getState()).toEqual(controller.getState());

    await session.start({ sourceLang: 'en', targetLang: 'es' });
    expect(controller.getState().status).toBe('connected');
    expect(session.getState()).toEqual(controller.getState());

    session.stop();
    expect(controller.getState().status).toBe('idle');
  });

  // Catches the cross-transport collision bug (see InterpreterSession.test.ts):
  // if this adapter forwarded the raw OpenAI item_id unprefixed, a Realtime
  // utterance could collide with a Cascade one in the shared transcript kept
  // across a mode switch.
  it('prefixes transcript utteranceIds with "realtime:" before notifying subscribers', async () => {
    const { pc, dataChannel } = fakePeerConnection();
    const controller = new RealtimeSessionController(buildDeps({ createPeerConnection: () => pc }));
    const session = new RealtimeInterpreterSession(controller);
    const updates: unknown[] = [];
    session.subscribeToTranscript((update) => updates.push(update));

    await session.start({ sourceLang: 'en', targetLang: 'es' });
    (dataChannel as unknown as { onmessage: (event: { data: string }) => void }).onmessage({
      data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item_1', delta: 'Hi' }),
    });

    expect(updates).toEqual([{ utteranceId: 'realtime:item_1', lane: 'source', text: 'Hi', final: false }]);
  });
});
