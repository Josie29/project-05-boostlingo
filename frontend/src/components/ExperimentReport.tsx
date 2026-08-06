import { stageFamily } from '../latency/stageLabels';
import type { LatencyReport } from '../latency/types';
import type { WerResult } from '../lab/wer';
import type { TranscriptEntry } from '../transcript/types';

/**
 * What the report renders — built either from a just-finished runner result
 * or from a stored conversation's detail fetch (see `LabPanel`). `wer` is
 * `null` for runs with no ground truth (live sessions): the WER tiles and
 * diff simply don't render, and the transcript/latency evidence stands alone.
 */
export interface ExperimentReportData {
  title: string;
  wer: WerResult | null;
  transcript: TranscriptEntry[];
  latencyReports: LatencyReport[];
  utteranceCount: number;
  /** Recoverable stage failures the run survived — absent for stored runs, which don't persist them. */
  stageFailures?: string[];
}

/** Sum of a report's stage durations per pipeline segment. */
function segmentMs(report: LatencyReport): { stt: number; mt: number; tts: number } {
  const totals = { stt: 0, mt: 0, tts: 0 };
  for (const { stage, ms } of report.stages) {
    const bucket = stageFamily(stage);
    if (bucket !== 'other') totals[bucket] += ms;
  }
  return totals;
}

function formatMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}

function percentile(sorted: number[], p: number): number {
  // Nearest-rank, matching the backend's summary math.
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/**
 * The evidence behind a run: verdict tiles, the word-level alignment of
 * ground truth vs. what STT heard, the source/target transcript pair, and one
 * row per utterance with its pipeline-segment breakdown. The scores stay, as
 * headlines over the evidence.
 */
export function ExperimentReport({ data: result }: { data: ExperimentReportData }) {
  const { wer } = result;
  const endToEnd = result.latencyReports
    .map((report) => report.endToEndMs)
    .filter((ms): ms is number => ms !== null)
    .sort((a, b) => a - b);
  const median =
    endToEnd.length === 0
      ? null
      : endToEnd.length % 2 === 1
        ? endToEnd[(endToEnd.length - 1) / 2]
        : (endToEnd[endToEnd.length / 2 - 1] + endToEnd[endToEnd.length / 2]) / 2;
  const p95 = endToEnd.length === 0 ? null : percentile(endToEnd, 0.95);

  const sourceEntries = result.transcript.filter((entry) => entry.lane === 'source');
  const targetText = result.transcript
    .filter((entry) => entry.lane === 'target')
    .map((entry) => entry.text)
    .join(' ');
  const heardByUtterance = new Map(sourceEntries.map((entry) => [entry.id, entry.text]));

  const worstEndToEnd = endToEnd.length > 0 ? endToEnd[endToEnd.length - 1] : null;
  const maxEndToEnd = worstEndToEnd ?? 1;

  return (
    <div className="experiment-report">
      <p className="experiment-report__title">{result.title}</p>

      {(result.stageFailures?.length ?? 0) > 0 && (
        <div className="experiment-report__failures" role="status">
          <b>A stage failed during this run.</b> Its timings are missing, so the latency figures below
          cover only the stages that completed.
          <ul>
            {result.stageFailures?.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="experiment-report__tiles">
        {wer !== null && (
          <>
            <div className="experiment-report__tile">
              <span className="experiment-report__tile-label">WER</span>
              <b>{(wer.wer * 100).toFixed(1)}%</b>
              <small>
                {wer.substitutions + wer.insertions + wer.deletions} errors / {wer.referenceWords} words
              </small>
            </div>
            <div
              className="experiment-report__tile"
              title="S = substituted (wrong word) · I = inserted (word nobody said) · D = deleted (word dropped)"
            >
              <span className="experiment-report__tile-label">Errors</span>
              <b>
                {wer.substitutions}S · {wer.insertions}I · {wer.deletions}D
              </b>
            </div>
          </>
        )}
        <div className="experiment-report__tile">
          <span className="experiment-report__tile-label">e2e median</span>
          <b>{median !== null ? formatMs(median) : '—'}</b>
          {/* Nearest-rank p95 below ~5 samples is just the max (at n=1, the median itself) — show the sample size instead of a number that pretends to be a tail. */}
          {p95 !== null && endToEnd.length >= 5 ? (
            <small>p95 {formatMs(p95)}</small>
          ) : endToEnd.length === 0 && result.utteranceCount > 0 ? (
            // No utterance reached first audio out, so there is no latency to report -
            // distinct from "no utterances", which n=0 alone reads as.
            <small>no audio out</small>
          ) : (
            <small>n={endToEnd.length}</small>
          )}
        </div>
        <div className="experiment-report__tile">
          <span className="experiment-report__tile-label">Utterances</span>
          <b>{result.utteranceCount}</b>
        </div>
      </div>

      {wer !== null && (
        <>
      <p className="experiment-report__section">Recognition vs ground truth</p>
      <p className="experiment-report__diff">
        {wer.ops.map((op, index) => {
          switch (op.kind) {
            case 'match':
              return <span key={index}>{op.word} </span>;
            case 'substitution':
              return (
                <span key={index} title={`heard "${op.hypothesis}" for "${op.reference}"`}>
                  <del className="experiment-report__sub-ref">{op.reference}</del>
                  <mark className="experiment-report__sub">{op.hypothesis}</mark>{' '}
                </span>
              );
            case 'insertion':
              return (
                <mark key={index} className="experiment-report__ins" title="word nobody said">
                  {op.word}{' '}
                </mark>
              );
            case 'deletion':
              return (
                <del key={index} className="experiment-report__del" title="word dropped">
                  {op.word}{' '}
                </del>
              );
          }
        })}
      </p>
      <p className="experiment-report__legend">
        struck+replacement = substituted · dotted underline = inserted · struck alone = dropped
      </p>
        </>
      )}

      <div className="experiment-report__pair">
        <div className="experiment-report__lane">
          <span className="experiment-report__tile-label">Source · heard</span>
          <p>{sourceEntries.map((entry) => entry.text).join(' ')}</p>
        </div>
        <div className="experiment-report__lane">
          <span className="experiment-report__tile-label">Target · spoke</span>
          <p>{targetText}</p>
        </div>
      </div>

      {result.latencyReports.length > 0 && (
        <>
          <p className="experiment-report__section">Utterances · segments STT / MT / TTS</p>
          <div className="experiment-report__utterances-scroll">
          <table className="experiment-report__utterances">
            <tbody>
              {result.latencyReports.map((report, index) => {
                const segments = segmentMs(report);
                const heard = heardByUtterance.get(report.utteranceId) ?? '';
                const isWorst = report.endToEndMs !== null && report.endToEndMs === worstEndToEnd && endToEnd.length > 1;
                const total = segments.stt + segments.mt + segments.tts;
                return (
                  <tr key={report.utteranceId}>
                    <td className="experiment-report__utterance-index">{index + 1}</td>
                    <td className="experiment-report__utterance-text">{heard}</td>
                    <td className="experiment-report__utterance-bar-cell">
                      {report.endToEndMs !== null && total > 0 && (
                        <span
                          className="experiment-report__bar"
                          style={{ width: `${(report.endToEndMs / maxEndToEnd) * 100}%` }}
                          title={`STT ${formatMs(segments.stt)} · MT ${formatMs(segments.mt)} · TTS ${formatMs(segments.tts)}`}
                        >
                          <i data-segment="stt" style={{ width: `${(segments.stt / total) * 100}%` }} />
                          <i data-segment="mt" style={{ width: `${(segments.mt / total) * 100}%` }} />
                          <i data-segment="tts" style={{ width: `${(segments.tts / total) * 100}%` }} />
                        </span>
                      )}
                    </td>
                    <td className="experiment-report__utterance-total" data-worst={isWorst}>
                      {report.endToEndMs !== null ? formatMs(report.endToEndMs) : 'pending'}
                      {isWorst && ' ▲'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </>
      )}
    </div>
  );
}
