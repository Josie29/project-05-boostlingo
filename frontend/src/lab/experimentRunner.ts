import {
  reportConversationMetrics,
  type CascadeStageModels,
  type ConversationMetricsPayload,
  type LanguagePair,
} from '../api';
import { CascadeSessionController } from '../cascade/CascadeSessionController';
import { latencyReducer } from '../latency/latencyReducer';
import { INITIAL_LATENCY_STATE, type LatencyReport, type LatencyState } from '../latency/types';
import { CascadeInterpreterSession } from '../session/CascadeInterpreterSession';
import { modeOfPrefixedId, type InterpreterSession } from '../session/InterpreterSession';
import { transcriptReducer } from '../transcript/transcriptReducer';
import { INITIAL_TRANSCRIPT_STATE, type TranscriptEntry, type TranscriptState } from '../transcript/types';
import { createFixtureMicStream, type FixtureMicStream } from './audioFixture';
import { computeWer, type WerResult } from './wer';

/**
 * Where the run's audio comes from. A file replays at 1x and ends itself; the
 * microphone is a real session that runs until the operator stops it — same
 * pipeline, same scoring, so a live read-aloud is comparable to a replay.
 */
export type ExperimentSource = { kind: 'file'; file: Blob } | { kind: 'mic'; stopSignal: Promise<void> };

export interface ExperimentConfig {
  source: ExperimentSource;
  /** Label stored with the run — the file name, or how the mic run was captured. */
  fixtureName: string;
  /** Reference transcript of the fixture's source-language speech. */
  groundTruth: string;
  pair: LanguagePair;
  models: CascadeStageModels;
}

export interface ExperimentResult {
  conversationId: string;
  fixtureName: string;
  wer: WerResult;
  utteranceCount: number;
  /** Every transcript entry the run produced, both lanes — the report's evidence. */
  transcript: TranscriptEntry[];
  /** Every utterance's latency breakdown, in appearance order. */
  latencyReports: LatencyReport[];
  /**
   * Recoverable stage failures the session survived (a failed MT/TTS request, a
   * reopened STT stream). A live session shows these as dismissible notices; a
   * replay has nobody watching, and without them a run that lost a whole stage
   * reads as a healthy run with missing numbers.
   */
  stageFailures: string[];
}

export type ExperimentPhase = 'decoding' | 'running' | 'draining' | 'scoring';

/** The evidence accumulated so far, streamed to the UI as the replay runs. */
export interface ExperimentSnapshot {
  transcript: TranscriptEntry[];
  latencyReports: LatencyReport[];
}

/** Optional run-progress hooks — the live view during a replay. All fire on the runner's own event flow; none affect the run. */
export interface ExperimentObservers {
  onPhase?: (phase: ExperimentPhase) => void;
  /** Fires once with the fixture's duration, the progress bar's denominator — never for a mic run, which has no known length. */
  onStarted?: (durationMs: number) => void;
  /** Fires on every transcript/latency event with the accumulated evidence so far. */
  onUpdate?: (snapshot: ExperimentSnapshot) => void;
}

/** Collaborators, swappable in tests for jsdom's lack of AudioContext/WebSocket and for deterministic time. */
export interface ExperimentRunnerDeps {
  createFixtureStream: (file: Blob) => Promise<FixtureMicStream>;
  createSession: (fixtureMic: MediaStream) => InterpreterSession;
  /** A session on the real microphone, for a mic-sourced run. */
  createLiveSession: () => InterpreterSession;
  report: (payload: ConversationMetricsPayload) => Promise<void>;
  delay: (ms: number) => Promise<void>;
  now: () => number;
  newId: () => string;
}

function defaultDeps(): ExperimentRunnerDeps {
  return {
    createFixtureStream: createFixtureMicStream,
    // The fixture stream impersonates the mic; everything downstream (capture,
    // downsample, VAD, barge-in) runs exactly as a live session.
    createSession: (fixtureMic) =>
      new CascadeInterpreterSession(new CascadeSessionController({ getUserMedia: async () => fixtureMic })),
    createLiveSession: () => new CascadeInterpreterSession(new CascadeSessionController()),
    report: reportConversationMetrics,
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
  };
}

/**
 * How long after the fixture finishes playing the session keeps running, so
 * in-flight STT/MT/TTS for the tail utterances can settle before Stop.
 */
export const DRAIN_MS = 8_000;

/**
 * Replays an audio fixture through a real cascade session at 1× (honest VAD
 * pacing and latency), scores the recognized source transcript against the
 * ground truth, and persists the run as a kind=experiment conversation the
 * Lab table picks up.
 *
 * @throws {Error} When the file can't be decoded, the session fails to start,
 *   or the session dies mid-run.
 */
export async function runCascadeExperiment(
  config: ExperimentConfig,
  observers?: ExperimentObservers,
  deps: ExperimentRunnerDeps = defaultDeps(),
): Promise<ExperimentResult> {
  const onPhase = observers?.onPhase;
  let fixture: FixtureMicStream | null = null;
  if (config.source.kind === 'file') {
    onPhase?.('decoding');
    fixture = await deps.createFixtureStream(config.source.file);
    observers?.onStarted?.(fixture.durationMs);
  }

  const session = fixture === null ? deps.createLiveSession() : deps.createSession(fixture.stream);
  let transcript: TranscriptState = INITIAL_TRANSCRIPT_STATE;
  let latency: LatencyState = INITIAL_LATENCY_STATE;
  const stageFailures: string[] = [];
  const emitUpdate = () =>
    observers?.onUpdate?.({ transcript: transcript.entries, latencyReports: latency.reports });
  const unsubscribes = [
    session.subscribeToTranscript((update) => {
      transcript = transcriptReducer(transcript, update);
      emitUpdate();
    }),
    session.subscribeToLatency?.((report) => {
      latency = latencyReducer(latency, report);
      emitUpdate();
    }),
    session.subscribeToNotice?.((notice) => {
      if (!stageFailures.includes(notice.message)) stageFailures.push(notice.message);
    }),
  ];

  const startedAtMs = deps.now();
  try {
    onPhase?.('running');
    session.setStageModels?.(config.models);
    await session.start(config.pair);
    const stateAfterStart = session.getState();
    if (stateAfterStart.status === 'error') {
      throw new Error(stateAfterStart.errorMessage ?? 'The experiment session failed to start.');
    }

    // A file ends itself at its own duration; a mic run ends when the operator
    // says so. Either way the pipeline gets DRAIN_MS to settle the tail.
    await (fixture === null ? (config.source as { stopSignal: Promise<void> }).stopSignal : fixture.ended);
    onPhase?.('draining');
    await deps.delay(DRAIN_MS);

    // A session that died mid-replay produced a partial run; surface it rather
    // than scoring a truncated transcript as if the model performed badly.
    const stateAfterRun = session.getState();
    if (stateAfterRun.status === 'error') {
      throw new Error(stateAfterRun.errorMessage ?? 'The experiment session died mid-run.');
    }
  } finally {
    session.stop();
    for (const unsubscribe of unsubscribes) unsubscribe?.();
    await fixture?.dispose();
  }

  onPhase?.('scoring');
  const hypothesis = transcript.entries
    .filter((entry) => entry.lane === 'source')
    .map((entry) => entry.text)
    .join(' ');
  const wer = computeWer(config.groundTruth, hypothesis);

  const conversationId = deps.newId();
  const payload: ConversationMetricsPayload = {
    conversationId,
    sourceLang: config.pair.sourceLang,
    targetLang: config.pair.targetLang,
    startedAtMs,
    endedAtMs: deps.now(),
    utterances: latency.reports.map((report) => ({
      utteranceId: report.utteranceId,
      mode: modeOfPrefixedId(report.utteranceId),
      endToEndMs: report.endToEndMs,
      stages: report.stages.map(({ stage, ms }) => ({ stage, ms })),
    })),
    transcript: transcript.entries.map((entry) => ({
      utteranceId: entry.id,
      lane: entry.lane,
      text: entry.text,
      final: entry.final,
      ...(entry.truncated ? { truncated: true } : {}),
    })),
    ...(config.models.sttModel ? { sttModel: config.models.sttModel } : {}),
    ...(config.models.mtProvider ? { mtProvider: config.models.mtProvider } : {}),
    kind: 'experiment',
    wer: wer.wer,
    fixture: config.fixtureName,
    groundTruth: config.groundTruth,
  };
  await deps.report(payload);

  return {
    conversationId,
    fixtureName: config.fixtureName,
    wer,
    utteranceCount: latency.reports.length,
    transcript: transcript.entries,
    latencyReports: latency.reports,
    stageFailures,
  };
}
