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

  // Catches the same cross-transport collision bug as the transcript test above, for
  // latency reports (issue #10): an unprefixed "turn-1" could collide with a cascade
  // utteranceId in shared latency state kept across a mode switch.
  it('prefixes latency report utteranceIds with "realtime:" before notifying subscribers', async () => {
    const { pc, dataChannel } = fakePeerConnection();
    const controller = new RealtimeSessionController(buildDeps({ createPeerConnection: () => pc }));
    const session = new RealtimeInterpreterSession(controller);
    const reports: unknown[] = [];
    session.subscribeToLatency((report) => reports.push(report));

    await session.start({ sourceLang: 'en', targetLang: 'es' });
    const channel = dataChannel as unknown as { onmessage: (event: { data: string }) => void };
    channel.onmessage({ data: JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }) });
    channel.onmessage({ data: JSON.stringify({ type: 'output_audio_buffer.started' }) });

    expect(reports).toHaveLength(1);
    expect((reports[0] as { utteranceId: string; stages: unknown[] }).utteranceId).toBe('realtime:turn-1');
  });

  // Catches a stale-anchor bug: starting a new conversation on the same, reused
  // adapter instance (as `useInterpreterSession` does across repeated Start/Stop
  // cycles) must not let a pending speech_stopped anchor from the previous
  // conversation pair with an audio start from a brand-new one.
  it('resets the latency tracker on start()', async () => {
    const { pc, dataChannel } = fakePeerConnection();
    const controller = new RealtimeSessionController(buildDeps({ createPeerConnection: () => pc }));
    const session = new RealtimeInterpreterSession(controller);
    const reports: unknown[] = [];
    session.subscribeToLatency((report) => reports.push(report));

    await session.start({ sourceLang: 'en', targetLang: 'es' });
    const channel = dataChannel as unknown as { onmessage: (event: { data: string }) => void };
    channel.onmessage({ data: JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }) });
    session.stop();

    await session.start({ sourceLang: 'en', targetLang: 'es' });
    channel.onmessage({ data: JSON.stringify({ type: 'output_audio_buffer.started' }) });

    // If the previous session's speech_stopped anchor had survived reset(), this
    // audio start would pair with it and fabricate a bogus measurement.
    expect(reports).toHaveLength(0);
  });
});
