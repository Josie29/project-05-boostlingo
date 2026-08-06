import type { LatencyReport } from '../latency/types';
import type { ExperimentResult } from '../lab/experimentRunner';

/**
 * Buckets a cascade stage mark into the pipeline segment it belongs to, for
 * the per-utterance stacked bar. Stage names are the latency-mark vocabulary
 * (sttFinal, mtFirstToken, ...), so the prefix is the pipeline stage.
 */
function stageBucket(stage: string): 'stt' | 'mt' | 'tts' | 'other' {
  if (stage.startsWith('stt') || stage === 'speechEnd') return 'stt';
  if (stage.startsWith('mt')) return 'mt';
  if (stage.startsWith('tts')) return 'tts';
  return 'other';
}

/** Sum of a report's stage durations per pipeline segment. */
function segmentMs(report: LatencyReport): { stt: number; mt: number; tts: number } {
  const totals = { stt: 0, mt: 0, tts: 0 };
  for (const { stage, ms } of report.stages) {
    const bucket = stageBucket(stage);
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
 * The evidence behind a finished experiment run: verdict tiles, the word-level
 * alignment of ground truth vs. what STT heard, the source/target transcript
 * pair, and one row per utterance with its pipeline-segment breakdown. The
 * scores stay, as headlines over the evidence.
 */
export function ExperimentReport({ result }: { result: ExperimentResult }) {
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
      <p className="experiment-report__title">Run report · {result.fixtureName}</p>

      <div className="experiment-report__tiles">
        <div className="experiment-report__tile">
          <span className="experiment-report__tile-label">WER</span>
          <b>{(wer.wer * 100).toFixed(1)}%</b>
          <small>
            {wer.substitutions + wer.insertions + wer.deletions} errors / {wer.referenceWords} words
          </small>
        </div>
        <div className="experiment-report__tile">
          <span className="experiment-report__tile-label">Errors</span>
          <b>
            {wer.substitutions}S · {wer.insertions}I · {wer.deletions}D
          </b>
        </div>
        <div className="experiment-report__tile">
          <span className="experiment-report__tile-label">e2e median</span>
          <b>{median !== null ? formatMs(median) : '—'}</b>
          {p95 !== null && <small>p95 {formatMs(p95)}</small>}
        </div>
        <div className="experiment-report__tile">
          <span className="experiment-report__tile-label">Utterances</span>
          <b>{result.utteranceCount}</b>
        </div>
      </div>

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
                    <td className="experiment-report__utterance-text" title={heard}>
                      {heard.length > 44 ? `${heard.slice(0, 44)}…` : heard}
                    </td>
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
        </>
      )}
    </div>
  );
}
