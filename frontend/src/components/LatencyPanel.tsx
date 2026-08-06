import { compareStages, stageLabel, stageScope, stageSpan, StageScope } from '../latency/stageLabels';
import type { LatencySessionAverages, LatencyReport } from '../latency/types';
import { modeOfPrefixedId, type SessionMode } from '../session/InterpreterSession';

/** One scoreboard column: a mode, its brief target, and its own running averages. */
export interface LatencyModeColumn {
  mode: SessionMode;
  label: string;
  targetMs: number;
  averages: LatencySessionAverages;
}

export interface LatencyPanelProps {
  /** Scoreboard columns in display order — built by `SessionPanel`, which owns the mode->target mapping. */
  modes: LatencyModeColumn[];
  /** The most recently appeared utterances' latency breakdowns, oldest first, both modes interleaved. */
  recentReports: LatencyReport[];
}

/** Short chip text per mode; the full mode name rides along as the accessible label. */
const MODE_CHIP: Record<SessionMode, string> = { realtime: 'RT', cascade: 'CAS' };

function formatMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}

/**
 * Split-scoreboard latency panel: one column per mode, each judged against its
 * own brief target (Realtime 1.5s, Cascade 3.0s), plus a shared recent-utterance
 * list with mode chips. Mode identity is always chip text + color, never color
 * alone; over-target is an icon + delta, not a repaint.
 */
export function LatencyPanel({ modes, recentReports }: LatencyPanelProps) {
  const targetByMode = new Map(modes.map((column) => [column.mode, column.targetMs]));

  return (
    <section className="latency-panel" aria-label="Latency">
      <h3>Latency</h3>

      <div className="latency-panel__modes">
        {modes.map((column) => (
          <ModeColumn key={column.mode} column={column} />
        ))}
      </div>

      <div className="latency-panel__recent">
        <h4>Recent utterances</h4>
        {recentReports.length === 0 ? (
          <p className="latency-panel__empty">Nothing yet.</p>
        ) : (
          <ul className="latency-panel__report-list">
            {recentReports.map((report) => (
              <ReportRow
                key={report.utteranceId}
                report={report}
                targetMs={targetByMode.get(modeOfPrefixedId(report.utteranceId))}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function ModeColumn({ column }: { column: LatencyModeColumn }) {
  const { mode, label, targetMs, averages } = column;
  const average = averages.endToEndAverageMs;
  const overBy = average !== null ? Math.round(average - targetMs) : null;

  return (
    <div className="latency-panel__mode" data-mode={mode}>
      <p className="latency-panel__mode-name">
        <span className="latency-panel__dot" aria-hidden="true" />
        {label}
      </p>
      {averages.sampleCount === 0 ? (
        <p className="latency-panel__empty">No utterances yet.</p>
      ) : (
        <>
          <p className="latency-panel__average-total">
            {average !== null ? formatMs(average) : 'pending'}
            <span className="latency-panel__average-caption">avg end-to-end</span>
          </p>
          {overBy !== null && (
            <p className="latency-panel__target-status" data-over={overBy > 0}>
              {overBy > 0
                ? `▲ ${overBy}ms over ${(targetMs / 1000).toFixed(1)}s target`
                : `✓ under ${(targetMs / 1000).toFixed(1)}s target`}
            </p>
          )}
          {average !== null && (
            <div
              className="latency-panel__meter"
              role="meter"
              aria-label={`${label} average against target`}
              aria-valuenow={Math.round(average)}
              aria-valuemin={0}
              aria-valuemax={targetMs}
            >
              <span
                className="latency-panel__meter-fill"
                data-over={overBy !== null && overBy > 0}
                style={{ width: `${Math.min((average / targetMs) * 100, 100)}%` }}
              />
            </div>
          )}
          <ul className="latency-panel__stage-list">
            {[...averages.stageAverages]
              .sort((a, b) => compareStages(a.stage, b.stage))
              .map(({ stage, ms }) => (
                <li key={stage} title={stageSpan(stage)} data-after={stageScope(stage) === StageScope.AfterFirstAudio}>
                  <span>{stageLabel(stage)}</span>
                  <span>{formatMs(ms)}</span>
                </li>
              ))}
          </ul>
        </>
      )}
    </div>
  );
}

function ReportRow({ report, targetMs }: { report: LatencyReport; targetMs: number | undefined }) {
  const mode = modeOfPrefixedId(report.utteranceId);
  const overBy =
    report.endToEndMs !== null && targetMs !== undefined ? Math.round(report.endToEndMs - targetMs) : null;

  return (
    <li className="latency-panel__report" data-mode={mode}>
      <p className="latency-panel__report-total">
        <span className="latency-panel__chip" aria-label={mode}>
          {MODE_CHIP[mode]}
        </span>
        {report.endToEndMs !== null ? formatMs(report.endToEndMs) : 'pending'}
        {overBy !== null && (
          <span className="latency-panel__target-status" data-over={overBy > 0}>
            {overBy > 0 ? `▲ ${overBy}ms over target` : '✓'}
          </span>
        )}
      </p>
      {report.stages.length > 0 && (
        <ul className="latency-panel__report-stages">
          {report.stages.map(({ stage, ms }) => (
            <li key={stage} title={stageSpan(stage)} data-after={stageScope(stage) === StageScope.AfterFirstAudio}>
              <span>{stageLabel(stage)}</span>
              <span>{formatMs(ms)}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
