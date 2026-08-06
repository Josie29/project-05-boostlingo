import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getConversationDetail,
  getConversations,
  getSummary,
  pinBaseline,
  type CascadeStageModels,
  type ConversationDetail,
  type ConversationListing,
  type LanguagePair,
  type SummaryGroup,
} from '../api';
import { runCascadeExperiment, type ExperimentPhase, type ExperimentResult } from '../lab/experimentRunner';
import { compareStages, stageLabel, stageScope, stageSpan, StageScope } from '../latency/stageLabels';
import { computeWer, groundTruthLines } from '../lab/wer';
import type { TranscriptEntry } from '../transcript/types';
import { ExperimentReport, type ExperimentReportData } from './ExperimentReport';
import { GroundTruthField } from './GroundTruthField';
import { TranscriptPanel } from './TranscriptPanel';

/** Adapts a just-finished runner result to what the report renders. */
function reportFromResult(result: ExperimentResult): ExperimentReportData {
  return {
    title: `Run report · ${result.fixtureName}`,
    wer: result.wer,
    transcript: result.transcript,
    latencyReports: result.latencyReports,
    utteranceCount: result.utteranceCount,
    stageFailures: result.stageFailures,
  };
}

/**
 * Adapts a stored conversation to the same report. The WER diff is recomputed
 * here from the stored ground truth and hypothesis with the same scorer the
 * run used — the alignment is never persisted, so it can't drift from storage.
 */
function reportFromDetail(detail: ConversationDetail): ExperimentReportData {
  const hypothesis = detail.transcript
    .filter((entry) => entry.lane === 'source')
    .map((entry) => entry.text)
    .join(' ');
  return {
    title: `${detail.kind} · ${detail.fixture ?? new Date(detail.startedAtMs).toLocaleString()}`,
    wer: detail.groundTruth === null ? null : computeWer(detail.groundTruth, hypothesis),
    transcript: detail.transcript.map((entry) => ({
      id: entry.utteranceId,
      lane: entry.lane,
      text: entry.text,
      final: entry.final,
      ...(entry.truncated ? { truncated: true } : {}),
    })),
    latencyReports: detail.utterances.map((utterance) => ({
      utteranceId: utterance.utteranceId,
      stages: utterance.stages,
      endToEndMs: utterance.endToEndMs,
    })),
    utteranceCount: detail.utterances.length,
  };
}

export interface LabPanelProps {
  /** Language pair experiments run with — the same one Live sessions use. */
  pair: LanguagePair;
  /** Stage model picks from the cascade card — experiments honor them too. */
  stageModels: CascadeStageModels;
}

const PHASE_LABEL: Record<ExperimentPhase, string> = {
  decoding: 'Decoding audio…',
  running: 'Replaying at 1× — the file is the mic…',
  draining: 'File finished; letting the pipeline settle…',
  scoring: 'Scoring WER…',
};

function formatMs(ms: number | null): string {
  // == null also catches undefined from a backend predating these fields.
  return ms == null ? '—' : `${Math.round(ms)}ms`;
}

function formatDate(startedAtMs: number): string {
  return new Date(startedAtMs).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Which mode a conversation's utterances ran on — colors its pin toggle. */
function conversationMode(conversation: ConversationListing): 'realtime' | 'cascade' | 'mixed' {
  if (conversation.cascadeUtteranceCount > 0 && conversation.realtimeUtteranceCount === 0) return 'cascade';
  if (conversation.realtimeUtteranceCount > 0 && conversation.cascadeUtteranceCount === 0) return 'realtime';
  return 'mixed';
}

/** Both modes always get a card, so the pane's shape doesn't shift as baselines are pinned. */
const BASELINE_MODES = [
  { mode: 'realtime', label: 'Realtime' },
  { mode: 'cascade', label: 'Cascade' },
] as const;

/** One mode's pinned reference numbers, or the prompt to pin one. */
function BaselineCard({
  mode,
  label,
  group,
}: {
  mode: (typeof BASELINE_MODES)[number]['mode'];
  label: string;
  group: SummaryGroup | null;
}) {
  const sorted = [...(group?.stages ?? [])].sort((a, b) => compareStages(a.stage, b.stage));
  const afterFirstAudio = sorted.filter(({ stage }) => stageScope(stage) === StageScope.AfterFirstAudio);

  return (
    <div className="lab-panel__baseline-card" data-mode={mode}>
      <p className="lab-panel__baseline-name">{label}</p>
      {group === null ? (
        <p className="lab-panel__empty">Nothing pinned. Pin a {label.toLowerCase()} run below to populate this.</p>
      ) : (
        <>
          <p className="lab-panel__baseline-total">
            {group.endToEnd ? formatMs(group.endToEnd.medianMs) : '—'}
            <span className="lab-panel__baseline-caption">
              median perceived latency · speech end → first audio out · {group.utteranceCount} utterances
            </span>
          </p>
          <ul className="lab-panel__baseline-stages">
            {sorted
              .filter(({ stage }) => stageScope(stage) === StageScope.Perceived)
              .map(({ stage, stats }) => (
                <li key={stage} title={stageSpan(stage)}>
                  <span>{stageLabel(stage)}</span>
                  <span className="lab-panel__baseline-stage-value">{formatMs(stats.medianMs)}</span>
                </li>
              ))}
          </ul>
          {/* Medians of separate distributions don't add, and the total is
              client-measured while the stages are server-measured. */}
          <p className="lab-panel__baseline-note">Stage medians don&apos;t sum exactly to the total.</p>
          {afterFirstAudio.length > 0 && (
            <ul className="lab-panel__baseline-stages" data-after="true">
              {afterFirstAudio.map(({ stage, stats }) => (
                <li key={stage} title={stageSpan(stage)}>
                  <span>{stageLabel(stage)}</span>
                  <span className="lab-panel__baseline-stage-value">{formatMs(stats.medianMs)}</span>
                </li>
              ))}
              <li className="lab-panel__baseline-note">
                <span>Not latency — the listener is already hearing it.</span>
              </li>
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The Lab view (P1+P2): a baseline pane showing the pinned reference numbers per
 * mode, and the experiments table — one row per stored conversation with its
 * stage config and per-mode medians. Read-only apart from the pin action, and
 * socket-free, so viewing it never disturbs a live session.
 */
export function LabPanel({ pair, stageModels }: LabPanelProps) {
  const [conversations, setConversations] = useState<ConversationListing[] | null>(null);
  const [baselineGroups, setBaselineGroups] = useState<SummaryGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const [groundTruth, setGroundTruth] = useState('');
  const [runPhase, setRunPhase] = useState<ExperimentPhase | null>(null);
  const [runResult, setRunResult] = useState<ExperimentResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ExperimentReportData | null>(null);

  const [liveEntries, setLiveEntries] = useState<TranscriptEntry[]>([]);
  const [liveUtteranceCount, setLiveUtteranceCount] = useState(0);
  const [runDurationMs, setRunDurationMs] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  // Ticks the progress bar along the file's own timeline while replaying —
  // the replay is 1× by construction, so wall clock IS file position.
  useEffect(() => {
    if (runPhase !== 'running') return;
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 250);
    return () => clearInterval(timer);
  }, [runPhase]);

  const refresh = useCallback(() => {
    // group='mode': the baseline pane is per-paradigm; the MT provider is one of
    // the variables under test, not a separate column.
    Promise.all([getConversations(), getSummary('baseline', 'mode')])
      .then(([listings, baseline]) => {
        setConversations(listings);
        setBaselineGroups(baseline.groups);
        setError(null);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Failed to load the Lab.'));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** Adds or removes one conversation from the baseline set; the backend replaces the set wholesale, so the full new set is posted each time. */
  function togglePin(conversation: ConversationListing): void {
    if (!conversations) return;
    const pinned = conversations
      .filter((candidate) =>
        candidate.conversationId === conversation.conversationId ? !conversation.baseline : candidate.baseline,
      )
      .map((candidate) => candidate.conversationId);
    pinBaseline(pinned)
      .then(refresh)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Failed to update the baseline.'));
  }

  function viewConversation(conversationId: string): void {
    getConversationDetail(conversationId)
      .then((loaded) => setDetail(reportFromDetail(loaded)))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Failed to load the run.'));
  }

  function clearBaseline(): void {
    pinBaseline([])
      .then(refresh)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Failed to clear the baseline.'));
  }

  // The same parse the field previews — scoring an empty reference would report
  // WER 1.0, which reads as a total model failure rather than an empty paste.
  const utterances = groundTruthLines(groundTruth);

  function handleRun(): void {
    const file = fileRef.current?.files?.[0];
    if (!file || utterances.length === 0 || runPhase !== null) return;

    setRunResult(null);
    setRunError(null);
    setLiveEntries([]);
    setLiveUtteranceCount(0);
    setRunDurationMs(null);
    setElapsedMs(0);
    runCascadeExperiment(
      { file, fixtureName: file.name, groundTruth: utterances.join('\n'), pair, models: stageModels },
      {
        onPhase: setRunPhase,
        onStarted: setRunDurationMs,
        onUpdate: (snapshot) => {
          setLiveEntries(snapshot.transcript);
          setLiveUtteranceCount(snapshot.latencyReports.length);
        },
      },
    )
      .then((result) => {
        setRunResult(result);
        refresh();
      })
      .catch((cause: unknown) => setRunError(cause instanceof Error ? cause.message : 'The experiment failed.'))
      .finally(() => setRunPhase(null));
  }

  const hasBaseline = baselineGroups !== null && baselineGroups.length > 0;

  return (
    <div className="lab-panel__sections">
      <section className="lab-panel" aria-label="Baseline">
        <div className="lab-panel__header">
          <h3>Baseline</h3>
          {hasBaseline && (
            <button type="button" className="lab-panel__refresh" onClick={clearBaseline}>
              Clear baseline
            </button>
          )}
        </div>
        <div className="lab-panel__baselines">
          {BASELINE_MODES.map(({ mode, label }) => (
            <BaselineCard
              key={mode}
              mode={mode}
              label={label}
              group={baselineGroups?.find((candidate) => candidate.mode === mode) ?? null}
            />
          ))}
        </div>
      </section>

      <section className="lab-panel" aria-label="Run an experiment">
        <div className="lab-panel__header">
          <h3>Run an experiment</h3>
        </div>
        <p className="lab-panel__empty">
          Cascade only for now. Replays an audio file through a cascade session (models from the Live card) and
          scores the recognized transcript against your ground truth — WER measures the speech-to-text output
          only, not translation quality. Keep this tab open; you&apos;ll hear the TTS output as it runs.
        </p>
        <div className="lab-panel__run-form">
          <input ref={fileRef} type="file" accept="audio/*,video/*" aria-label="Fixture audio file" />

          <GroundTruthField value={groundTruth} onChange={setGroundTruth} />

          <button
            type="button"
            className="lab-panel__refresh"
            onClick={handleRun}
            disabled={runPhase !== null || utterances.length === 0}
          >
            {runPhase === null ? 'Run experiment' : 'Running…'}
          </button>
          {runPhase !== null && <p className="lab-panel__empty">{PHASE_LABEL[runPhase]}</p>}
          {runError !== null && <p className="lab-panel__error">{runError}</p>}
        </div>
        {runPhase !== null && runDurationMs !== null && (
          <div className="lab-panel__live">
            <div
              className="lab-panel__progress-track"
              role="progressbar"
              aria-label="Replay position"
              aria-valuemin={0}
              aria-valuemax={Math.round(runDurationMs / 1000)}
              aria-valuenow={Math.round(Math.min(elapsedMs, runDurationMs) / 1000)}
            >
              <span
                className="lab-panel__progress-fill"
                style={{
                  width: `${runPhase === 'running' ? Math.min((elapsedMs / runDurationMs) * 100, 100) : 100}%`,
                }}
              />
            </div>
            <p className="lab-panel__live-status num">
              {Math.round(Math.min(elapsedMs, runDurationMs) / 1000)}s / {Math.round(runDurationMs / 1000)}s ·{' '}
              {liveUtteranceCount} utterances
            </p>
            {liveEntries.length > 0 && <TranscriptPanel entries={liveEntries} />}
          </div>
        )}
        {runResult !== null && <ExperimentReport data={reportFromResult(runResult)} />}
      </section>

      <section className="lab-panel" aria-label="Experiments">
        <div className="lab-panel__header">
          <h3>Experiments</h3>
          <button type="button" className="lab-panel__refresh" onClick={refresh}>
            Refresh
          </button>
        </div>

        {error !== null && <p className="lab-panel__error">{error}</p>}
        {detail !== null && (
          <div className="lab-panel__detail">
            <ExperimentReport data={detail} />
            <button type="button" className="lab-panel__refresh" onClick={() => setDetail(null)}>
              Close
            </button>
          </div>
        )}
        {conversations !== null && conversations.length === 0 && (
          <p className="lab-panel__empty">No sessions captured yet. Run a session and press Stop — it lands here.</p>
        )}
        {conversations !== null && conversations.length > 0 && (
          <div className="lab-panel__table-scroll">
            <table className="lab-panel__table">
              <thead>
                <tr>
                  <th>Baseline</th>
                  <th>When</th>
                  <th>Kind</th>
                  <th>Pair</th>
                  <th>STT</th>
                  <th>MT</th>
                  <th>TTS</th>
                  <th>RT e2e med</th>
                  <th>CAS e2e med</th>
                  <th>WER</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {conversations.map((conversation) => (
                  <tr key={conversation.conversationId}>
                    <td>
                      <button
                        type="button"
                        className="lab-panel__pin"
                        aria-pressed={conversation.baseline}
                        data-mode={conversationMode(conversation)}
                        onClick={() => togglePin(conversation)}
                      >
                        {conversation.baseline ? 'Pinned' : 'Pin'}
                      </button>
                    </td>
                    <td>{formatDate(conversation.startedAtMs)}</td>
                    <td>{conversation.kind}</td>
                    <td>
                      {conversation.sourceLang}→{conversation.targetLang}
                    </td>
                    {/* Realtime-only rows ran one model for the whole pipeline; the display
                        override also corrects rows stored before per-stage stamping existed. */}
                    {conversationMode(conversation) === 'realtime' ? (
                      <td colSpan={3}>
                        <code>gpt-realtime</code>
                      </td>
                    ) : (
                      <>
                        <td>
                          <code>{conversation.sttModel}</code>
                        </td>
                        <td>
                          <code>{conversation.mtModel ?? conversation.translationProvider}</code>
                        </td>
                        <td>
                          <code>{conversation.ttsModel ?? '—'}</code>
                        </td>
                      </>
                    )}
                    <td>{formatMs(conversation.realtimeEndToEndMedianMs)}</td>
                    <td>{formatMs(conversation.cascadeEndToEndMedianMs)}</td>
                    <td>{conversation.wer == null ? '—' : `${(conversation.wer * 100).toFixed(1)}%`}</td>
                    <td>
                      <button
                        type="button"
                        className="lab-panel__pin"
                        onClick={() => viewConversation(conversation.conversationId)}
                      >
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
