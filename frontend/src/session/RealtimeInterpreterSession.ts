import type { LanguagePair } from '../api';
import { RealtimeLatencyTracker } from '../latency/realtimeLatencyAdapter';
import type { LatencyReport } from '../latency/types';
import { RealtimeSessionController } from '../realtime/RealtimeSessionController';
import { mapRealtimeEventToTranscriptUpdate } from '../realtime/realtimeTranscriptAdapter';
import type { TranscriptUpdate } from '../transcript/types';
import { prefixLatencyReport, prefixUtteranceId, type InterpreterSession, type SessionState } from './InterpreterSession';
import { ListenerSet } from './listenerSet';

/**
 * Thin adapter presenting {@link RealtimeSessionController} as an
 * {@link InterpreterSession}, so the shared session UI can drive a Realtime
 * (WebRTC) session without importing anything WebRTC-specific.
 *
 * Also owns a `RealtimeLatencyTracker` (issue #10), fed from the controller's
 * unfiltered data-channel fan-out — see `realtimeLatencyAdapter.ts` for which
 * boundaries it pairs and why they must come from the data channel rather
 * than the remote `<audio>` element.
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
  private readonly latencyListeners = new ListenerSet<LatencyReport>();

  constructor(
    controller: RealtimeSessionController = new RealtimeSessionController(),
    latencyTracker: RealtimeLatencyTracker = new RealtimeLatencyTracker(),
  ) {
    this.controller = controller;
    this.latencyTracker = latencyTracker;
    this.controller.subscribeToEvents((event) =>
      this.emitLatencyReport(this.latencyTracker.handleEvent(event, performance.now())),
    );
  }

  /** Namespaces a report's utteranceId (see `prefixId`'s remarks) and fans it out, unless the tracker had no pending turn to report. */
  private emitLatencyReport(report: LatencyReport | null): void {
    if (!report) return;
    this.latencyListeners.emit(prefixLatencyReport(this.mode, report));
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
    return this.latencyListeners.add(listener);
  }

  start(pair: LanguagePair): Promise<void> {
    this.latencyTracker.reset();
    return this.controller.start(pair);
  }

  stop(): void {
    this.controller.stop();
  }
}
