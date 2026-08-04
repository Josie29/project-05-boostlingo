import type { LanguagePair } from '../api';
import { RealtimeSessionController } from '../realtime/RealtimeSessionController';
import { mapRealtimeEventToTranscriptUpdate } from '../realtime/realtimeTranscriptAdapter';
import type { TranscriptUpdate } from '../transcript/types';
import { prefixUtteranceId, type InterpreterSession, type SessionState } from './InterpreterSession';

/**
 * Thin adapter presenting {@link RealtimeSessionController} as an
 * {@link InterpreterSession}, so the shared session UI can drive a Realtime
 * (WebRTC) session without importing anything WebRTC-specific.
 *
 * Owns exactly one controller for its whole lifetime; `useInterpreterSession`
 * constructs one instance per mode and keeps it alive across mode switches so
 * `RealtimeSessionController`'s own reuse guarantees (one `<audio>` element,
 * no resource accumulation across start()/stop() cycles) keep holding.
 */
export class RealtimeInterpreterSession implements InterpreterSession {
  readonly mode = 'realtime' as const;
  private readonly controller: RealtimeSessionController;

  constructor(controller: RealtimeSessionController = new RealtimeSessionController()) {
    this.controller = controller;
  }

  getState(): SessionState {
    return this.controller.getState();
  }

  subscribe(listener: (state: SessionState) => void): () => void {
    return this.controller.subscribe(listener);
  }

  subscribeToTranscript(listener: (update: TranscriptUpdate) => void): () => void {
    return this.controller.subscribeToEvents((event) => {
      const update = mapRealtimeEventToTranscriptUpdate(event);
      if (update) listener(prefixUtteranceId(this.mode, update));
    });
  }

  start(pair: LanguagePair): Promise<void> {
    return this.controller.start(pair);
  }

  stop(): void {
    this.controller.stop();
  }
}
