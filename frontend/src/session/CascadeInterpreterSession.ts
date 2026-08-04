import type { LanguagePair } from '../api';
import { AudioPlaybackQueue } from '../cascade/AudioPlaybackQueue';
import { CascadeSessionController } from '../cascade/CascadeSessionController';
import { mapCascadeEventToTranscriptUpdate } from '../cascade/cascadeTranscriptAdapter';
import type { TranscriptUpdate } from '../transcript/types';
import { prefixUtteranceId, type InterpreterSession, type SessionState } from './InterpreterSession';

/**
 * Thin adapter presenting {@link CascadeSessionController} as an
 * {@link InterpreterSession}, so the shared session UI can drive a cascade
 * (STT -> MT -> TTS) session without importing anything WebSocket- or
 * Web-Audio-specific.
 *
 * Also owns the `AudioPlaybackQueue` that plays the target-lane TTS
 * (Text-to-Speech) audio (issue #7) — that wiring is entirely internal to
 * this mode, so it lives behind the adapter rather than leaking a
 * cascade-only concept (audio playback) into `InterpreterSession`. The queue
 * is torn down alongside the controller on every `stop()`, mirroring
 * `useCascadeSession`'s previous behavior: leaving the page or hitting Stop
 * mid-utterance silences audio immediately rather than letting
 * already-scheduled chunks keep playing out.
 *
 * Owns exactly one controller (and playback queue) for its whole lifetime;
 * `useInterpreterSession` constructs one instance per mode and keeps it
 * alive across mode switches.
 */
export class CascadeInterpreterSession implements InterpreterSession {
  readonly mode = 'cascade' as const;
  private readonly controller: CascadeSessionController;
  private readonly playbackQueue: AudioPlaybackQueue;

  constructor(
    controller: CascadeSessionController = new CascadeSessionController(),
    playbackQueue: AudioPlaybackQueue = new AudioPlaybackQueue(),
  ) {
    this.controller = controller;
    this.playbackQueue = playbackQueue;
    this.controller.subscribeToAudio((event) => this.playbackQueue.handleEvent(event));
  }

  getState(): SessionState {
    return this.controller.getState();
  }

  subscribe(listener: (state: SessionState) => void): () => void {
    return this.controller.subscribe(listener);
  }

  subscribeToTranscript(listener: (update: TranscriptUpdate) => void): () => void {
    return this.controller.subscribeToEvents((event) => {
      const update = mapCascadeEventToTranscriptUpdate(event);
      if (update) listener(prefixUtteranceId(this.mode, update));
    });
  }

  start(pair: LanguagePair): Promise<void> {
    return this.controller.start(pair);
  }

  stop(): void {
    this.controller.stop();
    void this.playbackQueue.stop();
  }
}
