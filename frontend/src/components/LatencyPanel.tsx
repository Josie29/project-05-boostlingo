import type { LatencyReport, LatencySessionAverages } from '../latency/types';

export interface LatencyPanelProps {
  /**
   * The perceived-latency target (ms) to show as a subtle hint, shown rather
   * than a pass/fail gate — no timers, no pressure. Mode-awareness (which
   * transport implies which target) lives in `SessionPanel`, the one
   * sanctioned mode-aware component — this panel just renders whatever
   * number it's given, keeping it usable for any future transport without
   * needing its own entry in a mode->benchmark table here.
   */
  benchmarkMs: number;
  /** The most recently appeared utterances' latency breakdowns, oldest first (mirrors `TranscriptPanel`'s append-order convention). */
  recentReports: LatencyReport[];
  /** Session-wide running averages, recomputed from every report accumulated so far. */
  averages: LatencySessionAverages;
}

/** Formats a millisecond value the way this panel renders every duration — rounded, unit-suffixed, monospaced via the panel's own CSS. */
function formatMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}

/**
 * Shared, mode-agnostic latency instrumentation UI (issue #10): a
 * session-wide averages summary plus a per-utterance stage breakdown for
 * the most recently appeared utterances. Takes only the transport-agnostic
 * {@link LatencyReport}/{@link LatencySessionAverages} domain types — no
 * cascade wire envelope or Realtime data-channel/WebRTC specifics — so
 * either mode's adapter can feed it without this component changing.
 *
 * Deliberately informational only: no timers, no pass/fail styling on the
 * benchmark hint, nothing framed as a grade — just what actually happened.
 */
export function LatencyPanel({ benchmarkMs, recentReports, averages }: LatencyPanelProps) {
  return (
    <section className="latency-panel" aria-label="Latency">
      <div className="latency-panel__header">
        <h3>Latency</h3>
        <p className="latency-panel__hint">Target: under {(benchmarkMs / 1000).toFixed(1)}s</p>
      </div>

      <div className="latency-panel__averages">
        {averages.sampleCount === 0 ? (
          <p className="latency-panel__empty">No utterances yet.</p>
        ) : (
          <>
            <p className="latency-panel__average-total">
              Avg end-to-end:{' '}
              {averages.endToEndAverageMs !== null ? formatMs(averages.endToEndAverageMs) : 'pending'}
            </p>
            <ul className="latency-panel__stage-list">
              {averages.stageAverages.map(({ stage, ms }) => (
                <li key={stage}>
                  {stage}: {formatMs(ms)}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="latency-panel__recent">
        <h4>Recent utterances</h4>
        {recentReports.length === 0 ? (
          <p className="latency-panel__empty">Nothing yet.</p>
        ) : (
          <ul className="latency-panel__report-list">
            {recentReports.map((report) => (
              <li key={report.utteranceId} className="latency-panel__report">
                <p className="latency-panel__report-total">
                  {report.endToEndMs !== null ? formatMs(report.endToEndMs) : 'pending'}
                </p>
                {report.stages.length > 0 && (
                  <ul className="latency-panel__report-stages">
                    {report.stages.map(({ stage, ms }) => (
                      <li key={stage}>
                        {stage}: {formatMs(ms)}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
