import {
  reportConversationMetrics,
  type CascadeStageModels,
  type ConversationMetricsPayload,
  type LanguagePair,
} from '../api';
import { CascadeSessionController } from '../cascade/CascadeSessionController';
import { latencyReducer } from '../latency/latencyReducer';
import { INITIAL_LATENCY_STATE, type LatencyState } from '../latency/types';
import { CascadeInterpreterSession } from '../session/CascadeInterpreterSession';
import { modeOfPrefixedId, type InterpreterSession } from '../session/InterpreterSession';
import { transcriptReducer } from '../transcript/transcriptReducer';
import { INITIAL_TRANSCRIPT_STATE, type TranscriptState } from '../transcript/types';
import { createFixtureMicStream, type FixtureMicStream } from './audioFixture';
import { computeWer, type WerResult } from './wer';

export interface ExperimentConfig {
  file: Blob;
  /** Label stored with the run, e.g. the file name. */
  fixtureName: string;
  /** Reference transcript of the fixture's source-language speech. */
  groundTruth: string;
  pair: LanguagePair;
  models: CascadeStageModels;
}

export interface ExperimentResult {
  conversationId: string;
  wer: WerResult;
  utteranceCount: number;
}

export type ExperimentPhase = 'decoding' | 'running' | 'draining' | 'scoring';

/** Collaborators, swappable in tests for jsdom's lack of AudioContext/WebSocket and for deterministic time. */
export interface ExperimentRunnerDeps {
  createFixtureStream: (file: Blob) => Promise<FixtureMicStream>;
  createSession: (fixtureMic: MediaStream) => InterpreterSession;
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
  onPhase?: (phase: ExperimentPhase) => void,
  deps: ExperimentRunnerDeps = defaultDeps(),
): Promise<ExperimentResult> {
  onPhase?.('decoding');
  const fixture = await deps.createFixtureStream(config.file);

  const session = deps.createSession(fixture.stream);
  let transcript: TranscriptState = INITIAL_TRANSCRIPT_STATE;
  let latency: LatencyState = INITIAL_LATENCY_STATE;
  const unsubscribes = [
    session.subscribeToTranscript((update) => {
      transcript = transcriptReducer(transcript, update);
    }),
    session.subscribeToLatency?.((report) => {
      latency = latencyReducer(latency, report);
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

    await fixture.ended;
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
    await fixture.dispose();
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
  };
  await deps.report(payload);

  return { conversationId, wer, utteranceCount: latency.reports.length };
}
