import type { LanguagePair } from '../api';
import { AudioPlaybackQueue } from '../cascade/AudioPlaybackQueue';
import { CascadeSessionController } from '../cascade/CascadeSessionController';
import { mapCascadeEventToTranscriptUpdate } from '../cascade/cascadeTranscriptAdapter';
import { CascadeLatencyTracker } from '../latency/cascadeLatencyAdapter';
import type { LatencyReport } from '../latency/types';
import type { TranscriptUpdate } from '../transcript/types';
import { prefixId, prefixUtteranceId, type InterpreterSession, type SessionState } from './InterpreterSession';

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
 * Owns a `CascadeLatencyTracker` (issue #10) the same way: it folds every
 * `latency.mark` envelope (via the controller's unfiltered event fan-out,
 * same source `subscribeToTranscript` reads) and every TTS first-chunk
 * timing sample (via the playback queue) into per-utterance
 * {@link LatencyReport}s, reset on every `start()` so a new conversation
 * doesn't inherit a previous one's in-progress utterances.
 *
 * Owns exactly one controller (and playback queue) for its whole lifetime;
 * `useInterpreterSession` constructs one instance per mode and keeps it
 * alive across mode switches.
 */
export class CascadeInterpreterSession implements InterpreterSession {
  readonly mode = 'cascade' as const;
  private readonly controller: CascadeSessionController;
  private readonly playbackQueue: AudioPlaybackQueue;
  private readonly latencyTracker: CascadeLatencyTracker;
  private readonly latencyListeners = new Set<(report: LatencyReport) => void>();

  constructor(
    controller: CascadeSessionController = new CascadeSessionController(),
    playbackQueue: AudioPlaybackQueue = new AudioPlaybackQueue(),
    latencyTracker: CascadeLatencyTracker = new CascadeLatencyTracker(),
  ) {
    this.controller = controller;
    this.playbackQueue = playbackQueue;
    this.latencyTracker = latencyTracker;
    this.controller.subscribeToAudio((event) => this.playbackQueue.handleEvent(event));
    this.controller.subscribeToEvents((event) => this.emitLatencyReport(this.latencyTracker.handleEnvelope(event)));
    this.playbackQueue.subscribeToFirstChunkTiming((timing) =>
      this.emitLatencyReport(this.latencyTracker.handleFirstChunkTiming(timing)),
    );
  }

  /** Namespaces a report's utteranceId (see `prefixId`'s remarks) and fans it out, unless the tracker had nothing to report (e.g. a non-latency envelope). */
  private emitLatencyReport(report: LatencyReport | null): void {
    if (!report) return;
    const prefixed = { ...report, utteranceId: prefixId(this.mode, report.utteranceId) };
    for (const listener of this.latencyListeners) listener(prefixed);
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

  subscribeToLatency(listener: (report: LatencyReport) => void): () => void {
    this.latencyListeners.add(listener);
    return () => {
      this.latencyListeners.delete(listener);
    };
  }

  start(pair: LanguagePair): Promise<void> {
    this.latencyTracker.reset();
    return this.controller.start(pair);
  }

  stop(): void {
    this.controller.stop();
    void this.playbackQueue.stop();
  }
}
