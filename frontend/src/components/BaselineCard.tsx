import type { SummaryGroup } from '../api';
import { compareStages, stageFamily, stageLabel, stageScope, stageSpan, StageScope } from '../latency/stageLabels';
import { BENCHMARK_TARGET_MS } from '../latency/targets';
import type { SessionMode } from '../session/InterpreterSession';

/**
 * Which reading of a stage's number the breakdown is showing. The distinction
 * is invisible in a bare column of durations — 963ms could be "this step took
 * 963ms" or "we were 963ms in when it finished" — so it is carried three ways
 * at once: bar geometry, value format, and the column header.
 */
export const LatencyFrame = {
  /** Each step's own duration. Bars share a left edge, so lengths compare directly. */
  Step: 'step',
  /** Elapsed since speech ended. Bars offset into a waterfall against the axis. */
  Total: 'total',
} as const;

export type LatencyFrame = (typeof LatencyFrame)[keyof typeof LatencyFrame];

/** Axis ticks past the target keep a badly-over run from running off the end. */
const AXIS_HEADROOM = 1.15;

/** One row of the breakdown, positioned on the shared time axis. */
interface WaterfallRow {
  key: string;
  label: string;
  title?: string;
  family: string;
  ms: number;
  /** Elapsed when this row began; where its bar starts in the running-total frame. */
  startMs: number;
  /** Past first audio out — drawn hatched below the rule, never inside the sum. */
  after: boolean;
}

function formatMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Lays the group's stage medians out along one timeline: perceived-latency
 * stages in pipeline order, then the remainder between their sum and the
 * measured total, then anything past first audio out.
 *
 * The remainder row exists because the total is measured on the client's clock
 * while the stages are stamped on the server's — the difference is wire time no
 * mark can cover. Naming it is what lets the stack reconcile instead of looking
 * broken.
 */
function buildRows(group: SummaryGroup): WaterfallRow[] {
  const sorted = [...group.stages].sort((a, b) => compareStages(a.stage, b.stage));
  const rows: WaterfallRow[] = [];
  let elapsed = 0;

  for (const { stage, stats } of sorted.filter(({ stage }) => stageScope(stage) === StageScope.Perceived)) {
    rows.push({
      key: stage,
      label: stageLabel(stage),
      title: stageSpan(stage),
      family: stageFamily(stage),
      ms: stats.medianMs,
      startMs: elapsed,
      after: false,
    });
    elapsed += stats.medianMs;
  }

  const remainderMs = (group.endToEnd?.medianMs ?? 0) - elapsed;
  // Sub-millisecond remainders are median rounding, not a leg worth a row.
  if (group.endToEnd !== null && remainderMs >= 1) {
    rows.push({
      key: 'network',
      label: 'Network + playback',
      title: 'wire time no server mark can cover, plus the browser scheduling the audio',
      family: 'other',
      ms: remainderMs,
      startMs: elapsed,
      after: false,
    });
    elapsed += remainderMs;
  }

  for (const { stage, stats } of sorted.filter(({ stage }) => stageScope(stage) === StageScope.AfterFirstAudio)) {
    rows.push({
      key: stage,
      label: stageLabel(stage),
      title: stageSpan(stage),
      family: stageFamily(stage),
      ms: stats.medianMs,
      startMs: elapsed,
      after: true,
    });
  }

  return rows;
}

export interface BaselineCardProps {
  mode: SessionMode;
  label: string;
  /** The pinned set's stats for this mode, or `null` when nothing is pinned. */
  group: SummaryGroup | null;
  frame: LatencyFrame;
}

/**
 * One mode's pinned reference numbers as a waterfall against the brief's target,
 * or the prompt to pin a run. The card holds its space either way.
 */
export function BaselineCard({ mode, label, group, frame }: BaselineCardProps) {
  const targetMs = BENCHMARK_TARGET_MS[mode];

  if (group === null) {
    return (
      <div className="baseline-card" data-mode={mode} data-empty="true">
        <p className="baseline-card__name">{label}</p>
        <p className="lab-panel__empty">Nothing pinned. Pin a {label.toLowerCase()} run below to populate this.</p>
      </div>
    );
  }

  const rows = buildRows(group);
  const totalMs = group.endToEnd?.medianMs ?? null;
  const overBy = totalMs === null ? null : Math.round(totalMs - targetMs);
  const axisMaxMs = Math.max(targetMs * AXIS_HEADROOM, ...rows.map((row) => row.startMs + row.ms));
  const pct = (ms: number) => (ms / axisMaxMs) * 100;
  // A tick sitting under the target line just collides with its label.
  const ticks = Array.from({ length: Math.floor(axisMaxMs / 1000) }, (_, index) => (index + 1) * 1000).filter(
    (ms) => Math.abs(ms - targetMs) > axisMaxMs * 0.08,
  );

  return (
    <div className="baseline-card" data-mode={mode}>
      <p className="baseline-card__name">{label}</p>
      <p className="baseline-card__total">
        {totalMs === null ? '—' : formatSeconds(totalMs)}
        <span className="baseline-card__caption">
          perceived latency · {group.utteranceCount} {group.utteranceCount === 1 ? 'utterance' : 'utterances'}
        </span>
        {overBy !== null && (
          <span className="baseline-card__verdict" data-over={overBy > 0}>
            {overBy > 0
              ? `▲ ${formatSeconds(overBy)} over ${(targetMs / 1000).toFixed(1)}s`
              : `✓ under ${(targetMs / 1000).toFixed(1)}s`}
          </span>
        )}
      </p>

      <table className="baseline-card__breakdown">
        <thead>
          <tr>
            <th>Step</th>
            <th />
            <th className="baseline-card__value">
              {frame === LatencyFrame.Step ? 'Step duration' : 'Clock at finish'}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} data-after={row.after || undefined} title={row.title}>
              <td className="baseline-card__label">{row.label}</td>
              <td className="baseline-card__track-cell">
                <span className="baseline-card__track">
                  <span
                    className="baseline-card__bar"
                    data-family={row.family}
                    data-ghost={row.after || undefined}
                    style={{
                      left: `${frame === LatencyFrame.Step ? 0 : pct(row.startMs)}%`,
                      width: `${pct(row.ms)}%`,
                    }}
                  />
                </span>
              </td>
              <td className="baseline-card__value">
                {row.after || frame === LatencyFrame.Step
                  ? `${row.after ? '' : '+'}${formatMs(row.ms)}`
                  : formatSeconds(row.startMs + row.ms)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          {/* In the table, not beside it: the axis has to share the track column's
              geometry or the ticks read against the wrong scale. */}
          <tr>
            <td />
            <td className="baseline-card__track-cell">
              <span className="baseline-card__axis">
                {ticks.map((ms) => (
                  <i key={ms} className="baseline-card__tick" style={{ left: `${pct(ms)}%` }}>
                    <span>{ms / 1000}s</span>
                  </i>
                ))}
                <i className="baseline-card__target" style={{ left: `${pct(targetMs)}%` }}>
                  <span>target {(targetMs / 1000).toFixed(1)}s</span>
                </i>
              </span>
            </td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
