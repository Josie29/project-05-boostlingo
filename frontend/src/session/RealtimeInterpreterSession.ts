import type { LanguagePair } from '../api';
import { RealtimeLatencyTracker } from '../latency/realtimeLatencyAdapter';
import type { LatencyReport } from '../latency/types';
import { RealtimeSessionController } from '../realtime/RealtimeSessionController';
import { mapRealtimeEventToTranscriptUpdate } from '../realtime/realtimeTranscriptAdapter';
import type { TranscriptUpdate } from '../transcript/types';
import { prefixId, prefixUtteranceId, type InterpreterSession, type SessionState } from './InterpreterSession';

/**
 * Thin adapter presenting {@link RealtimeSessionController} as an
 * {@link InterpreterSession}, so the shared session UI can drive a Realtime
 * (WebRTC) session without importing anything WebRTC-specific.
 *
 * Also owns a `RealtimeLatencyTracker` (issue #10): it feeds every
 * data-channel event (via the controller's own unfiltered fan-out) into the
 * tracker looking for `input_audio_buffer.speech_stopped`, and listens for
 * the remote `<audio>` element's `playing` event to pair with it — see
 * `realtimeLatencyAdapter.ts` for why this is the coarsest of the two
 * transports' instrumentation (no backend visibility, no shared id linking
 * the two boundaries). The `playing` listener is attached once, for this
 * adapter's whole lifetime, onto the controller's single reused audio
 * element (`RealtimeSessionController.getAudioElement()` never changes
 * instances across `start()`/`stop()` cycles), mirroring how
 * `CascadeInterpreterSession` wires its playback queue once in its own
 * constructor.
 *
 * Owns exactly one controller for its whole lifetime; `useInterpreterSession`
 * constructs one instance per mode and keeps it alive across mode switches so
 * `RealtimeSessionController`'s own reuse guarantees (one `<audio>` element,
 * no resource accumulation across start()/stop() cycles) keep holding.
 */
export class RealtimeInterpreterSession implements InterpreterSession {
  readonly mode = 'realtime' as const;
  private readonly controller: RealtimeSessionController;
  private readonly latencyTracker: RealtimeLatencyTracker;
  private readonly latencyListeners = new Set<(report: LatencyReport) => void>();

  constructor(
    controller: RealtimeSessionController = new RealtimeSessionController(),
    latencyTracker: RealtimeLatencyTracker = new RealtimeLatencyTracker(),
  ) {
    this.controller = controller;
    this.latencyTracker = latencyTracker;
    this.controller.subscribeToEvents((event) => this.latencyTracker.handleEvent(event, performance.now()));
    this.controller.getAudioElement().addEventListener('playing', () => {
      this.emitLatencyReport(this.latencyTracker.handleAudioPlaying(performance.now()));
    });
  }

  /** Namespaces a report's utteranceId (see `prefixId`'s remarks) and fans it out, unless the tracker had no pending turn to report. */
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
      const update = mapRealtimeEventToTranscriptUpdate(event);
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
  }
}
