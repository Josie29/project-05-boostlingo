import { describe, expect, it, vi } from 'vitest';
import type { ConversationMetricsPayload } from '../api';
import { runCascadeExperiment, type ExperimentRunnerDeps } from '../lab/experimentRunner';
import type { InterpreterSession, SessionNotice, SessionState } from '../session/InterpreterSession';
import type { LatencyReport } from '../latency/types';
import type { TranscriptUpdate } from '../transcript/types';

/** Fake session whose start() emits scripted transcript/latency, then settles at the given status. */
function fakeSession(options: {
  transcript?: TranscriptUpdate[];
  latency?: LatencyReport[];
  notices?: SessionNotice[];
  endStatus?: SessionState['status'];
  errorMessage?: string;
}): InterpreterSession & { stopCalls: number; stageModels: unknown } {
  let state: SessionState = { status: 'idle', errorMessage: null, errorKind: null, reconnectable: false };
  const transcriptListeners = new Set<(update: TranscriptUpdate) => void>();
  const latencyListeners = new Set<(report: LatencyReport) => void>();
  const noticeListeners = new Set<(notice: SessionNotice) => void>();

  const session = {
    mode: 'cascade' as const,
    stopCalls: 0,
    stageModels: null as unknown,
    getState: () => state,
    subscribe: () => () => {},
    subscribeToTranscript: (listener: (update: TranscriptUpdate) => void) => {
      transcriptListeners.add(listener);
      return () => transcriptListeners.delete(listener);
    },
    subscribeToLatency: (listener: (report: LatencyReport) => void) => {
      latencyListeners.add(listener);
      return () => latencyListeners.delete(listener);
    },
    subscribeToNotice: (listener: (notice: SessionNotice) => void) => {
      noticeListeners.add(listener);
      return () => noticeListeners.delete(listener);
    },
    setStageModels: (models: unknown) => {
      session.stageModels = models;
    },
    start: async () => {
      for (const update of options.transcript ?? []) for (const listener of transcriptListeners) listener(update);
      for (const report of options.latency ?? []) for (const listener of latencyListeners) listener(report);
      for (const notice of options.notices ?? []) for (const listener of noticeListeners) listener(notice);
      state = {
        status: options.endStatus ?? 'connected',
        errorMessage: options.errorMessage ?? null,
        errorKind: null,
        reconnectable: false,
      };
    },
    stop: () => {
      session.stopCalls += 1;
    },
  };
  return session;
}

function fakeDeps(session: InterpreterSession, reported: ConversationMetricsPayload[]): ExperimentRunnerDeps {
  return {
    createFixtureStream: async () => ({
      stream: {} as MediaStream,
      durationMs: 1_000,
      ended: Promise.resolve(),
      dispose: vi.fn(async () => {}),
    }),
    createSession: () => session,
    report: async (payload) => {
      reported.push(payload);
    },
    delay: async () => {},
    now: () => 1_754_400_000_000,
    newId: () => 'exp-1',
  };
}

const CONFIG = {
  file: {} as Blob,
  fixtureName: 'benchmark-en-es.wav',
  groundTruth: 'all tests pass',
  pair: { sourceLang: 'en', targetLang: 'es' },
  models: { mtProvider: 'anthropic' },
};

describe('runCascadeExperiment', () => {
  // Catches the whole P3 loop breaking: a replayed run must score its recognized
  // source transcript against the ground truth and persist a kind=experiment
  // conversation carrying the WER, fixture name, and stage config.
  it('scores the run and reports it as an experiment conversation', async () => {
    const session = fakeSession({
      transcript: [
        { utteranceId: 'cascade:a', lane: 'source', text: 'all tests', final: true },
        { utteranceId: 'cascade:b', lane: 'source', text: 'pass', final: true },
        { utteranceId: 'cascade:a-target', lane: 'target', text: 'todas las pruebas', final: true },
      ],
      latency: [{ utteranceId: 'cascade:a', stages: [{ stage: 'sttFinal', ms: 300 }], endToEndMs: 2_000 }],
    });
    const reported: ConversationMetricsPayload[] = [];

    const result = await runCascadeExperiment(CONFIG, undefined, fakeDeps(session, reported));

    expect(result.wer.wer).toBe(0);
    const payload = reported[0];
    expect(payload.kind).toBe('experiment');
    expect(payload.wer).toBe(0);
    expect(payload.fixture).toBe('benchmark-en-es.wav');
    expect(payload.groundTruth).toBe('all tests pass');
    expect(payload.mtProvider).toBe('anthropic');
    expect(payload.utterances).toHaveLength(1);
    expect(session.stageModels).toEqual({ mtProvider: 'anthropic' });
    expect(session.stopCalls).toBe(1);

    // The report renders from the result — the evidence must come back, not just scores.
    expect(result.transcript).toHaveLength(3);
    expect(result.latencyReports).toHaveLength(1);
    expect(result.fixtureName).toBe('benchmark-en-es.wav');
  });

  // Catches the live view staying blank while a replay runs: observers must get
  // the fixture duration up front and accumulating evidence as events land.
  it('streams accumulated evidence to observers as the run progresses', async () => {
    const session = fakeSession({
      transcript: [
        { utteranceId: 'cascade:a', lane: 'source', text: 'all tests', final: true },
        { utteranceId: 'cascade:b', lane: 'source', text: 'pass', final: true },
      ],
      latency: [{ utteranceId: 'cascade:a', stages: [], endToEndMs: 2_000 }],
    });
    const snapshots: { transcript: unknown[]; latencyReports: unknown[] }[] = [];
    let startedDurationMs = 0;

    await runCascadeExperiment(
      CONFIG,
      { onStarted: (durationMs) => { startedDurationMs = durationMs; }, onUpdate: (s) => snapshots.push(s) },
      fakeDeps(session, []),
    );

    expect(startedDurationMs).toBe(1_000);
    expect(snapshots.length).toBe(3);
    expect(snapshots.at(-1)!.transcript).toHaveLength(2);
    expect(snapshots.at(-1)!.latencyReports).toHaveLength(1);
  });

  // Catches a truncated run being scored as if the model performed badly: a
  // session that died mid-replay must fail the experiment, not report it.
  it('fails (and does not report) when the session dies', async () => {
    const session = fakeSession({ endStatus: 'error', errorMessage: 'STT stream died.' });
    const reported: ConversationMetricsPayload[] = [];

    await expect(runCascadeExperiment(CONFIG, undefined, fakeDeps(session, reported))).rejects.toThrow(
      'STT stream died.',
    );
    expect(reported).toHaveLength(0);
    expect(session.stopCalls).toBe(1);
  });
});

describe('runCascadeExperiment stage failures', () => {
  // A replay has nobody watching for the dismissible notice a live session shows,
  // so a run that lost TTS entirely reported healthy-looking numbers with an
  // unexplained gap. Catches stage failures being dropped again.
  it('collects recoverable stage failures, deduplicated', async () => {
    const session = fakeSession({
      notices: [
        { id: 'n1', message: 'Text-to-speech failed for one utterance.' },
        { id: 'n2', message: 'Text-to-speech failed for one utterance.' },
      ],
    });
    const result = await runCascadeExperiment(CONFIG, undefined, fakeDeps(session, []));

    expect(result.stageFailures).toEqual(['Text-to-speech failed for one utterance.']);
  });
});
