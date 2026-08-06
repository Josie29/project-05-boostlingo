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
import { computeWer } from '../lab/wer';
import { ExperimentReport, type ExperimentReportData } from './ExperimentReport';

/** Adapts a just-finished runner result to what the report renders. */
function reportFromResult(result: ExperimentResult): ExperimentReportData {
  return {
    title: `Run report · ${result.fixtureName}`,
    wer: result.wer,
    transcript: result.transcript,
    latencyReports: result.latencyReports,
    utteranceCount: result.utteranceCount,
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

/** A signed duration delta where lower is better: green ▼ improvement, red ▲ regression. */
function Delta({ deltaMs }: { deltaMs: number }) {
  const rounded = Math.round(deltaMs);
  if (rounded === 0) return <span className="lab-panel__delta-flat">±0ms</span>;
  return rounded < 0 ? (
    <span className="lab-panel__delta-down">▼ {-rounded}ms</span>
  ) : (
    <span className="lab-panel__delta-up">▲ {rounded}ms</span>
  );
}

/**
 * The Lab view (P1+P2): a progress pane diffing current sessions against the
 * pinned baseline set, and the experiments table — one row per stored
 * conversation with its stage config and per-mode medians. Read-only apart
 * from the pin action, and socket-free, so viewing it never disturbs a live
 * session.
 */
export function LabPanel({ pair, stageModels }: LabPanelProps) {
  const [conversations, setConversations] = useState<ConversationListing[] | null>(null);
  const [baselineGroups, setBaselineGroups] = useState<SummaryGroup[] | null>(null);
  const [currentGroups, setCurrentGroups] = useState<SummaryGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const [groundTruth, setGroundTruth] = useState('');
  const [runPhase, setRunPhase] = useState<ExperimentPhase | null>(null);
  const [runResult, setRunResult] = useState<ExperimentResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ExperimentReportData | null>(null);

  const refresh = useCallback(() => {
    // group='mode': the progress pane compares paradigms; the MT provider is one of
    // the variables under test, not a separate comparison column.
    Promise.all([getConversations(), getSummary('baseline', 'mode'), getSummary('current', 'mode')])
      .then(([listings, baseline, current]) => {
        setConversations(listings);
        setBaselineGroups(baseline.groups);
        setCurrentGroups(current.groups);
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

  function handleRun(): void {
    const file = fileRef.current?.files?.[0];
    if (!file || groundTruth.trim() === '' || runPhase !== null) return;

    setRunResult(null);
    setRunError(null);
    runCascadeExperiment(
      { file, fixtureName: file.name, groundTruth, pair, models: stageModels },
      setRunPhase,
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
      <section className="lab-panel" aria-label="Progress">
        <div className="lab-panel__header">
          <h3>Progress vs baseline</h3>
          {hasBaseline && (
            <button type="button" className="lab-panel__refresh" onClick={clearBaseline}>
              Clear baseline
            </button>
          )}
        </div>
        {!hasBaseline && (
          <p className="lab-panel__empty">
            No baseline pinned. Pin one representative session per mode below (e.g. one realtime, one cascade);
            later sessions are then compared against them here.
          </p>
        )}
        {hasBaseline && currentGroups !== null && (
          <div className="lab-panel__progress">
            {/* Only modes present in BOTH sets render — a card is a comparison, and a
                mode with no pinned counterpart has nothing to be compared against. */}
            {currentGroups
              .filter((group) => baselineGroups.some((candidate) => candidate.mode === group.mode))
              .map((group) => {
                const baselineGroup = baselineGroups.find((candidate) => candidate.mode === group.mode)!;
                return (
                  <div key={group.mode} className="lab-panel__progress-card" data-mode={group.mode}>
                    <p className="lab-panel__progress-name">{group.mode === 'realtime' ? 'Realtime' : 'Cascade'}</p>
                    <p className="lab-panel__progress-total">
                      {group.endToEnd ? formatMs(group.endToEnd.medianMs) : '—'}
                      {group.endToEnd && baselineGroup.endToEnd && (
                        <Delta deltaMs={group.endToEnd.medianMs - baselineGroup.endToEnd.medianMs} />
                      )}
                    </p>
                    <ul className="lab-panel__progress-stages">
                      {group.stages.map(({ stage, stats }) => {
                        const baselineStats = baselineGroup.stages.find((candidate) => candidate.stage === stage)?.stats;
                        return (
                          <li key={stage}>
                            {stage}: {formatMs(stats.medianMs)}{' '}
                            {baselineStats && <Delta deltaMs={stats.medianMs - baselineStats.medianMs} />}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            {currentGroups.length === 0 && (
              <p className="lab-panel__empty">Baseline pinned. New sessions will show their deltas here.</p>
            )}
          </div>
        )}
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
          <textarea
            className="lab-panel__ground-truth"
            aria-label="Ground truth transcript"
            placeholder="Paste the ground-truth transcript of the file's speech (e.g. from docs/benchmark-script.md)"
            value={groundTruth}
            onChange={(event) => setGroundTruth(event.target.value)}
            rows={4}
          />
          <button type="button" className="lab-panel__refresh" onClick={handleRun} disabled={runPhase !== null}>
            {runPhase === null ? 'Run experiment' : 'Running…'}
          </button>
          {runPhase !== null && <p className="lab-panel__empty">{PHASE_LABEL[runPhase]}</p>}
          {runError !== null && <p className="lab-panel__error">{runError}</p>}
        </div>
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
