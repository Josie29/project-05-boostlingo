import type { SummaryGroup } from '../api';
import { isCascadeStage } from '../latency/cascadeStages';
import {
  compareStages,
  FAMILY_LABEL,
  stageFamily,
  stageLabel,
  stageScope,
  stageSpan,
  StageScope,
  type StageFamily,
} from '../latency/stageLabels';
import { BENCHMARK_TARGET_MS } from '../latency/targets';
import type { SessionMode } from '../session/InterpreterSession';

/**
 * Which reading of a stage's number the value column is showing. 963ms could be
 * "this step took 963ms" or "we were 963ms in when it finished", and the digits
 * alone can't say which, so the column header names the frame too.
 *
 * The bars don't change: a waterfall already carries both readings at once —
 * where a bar starts is the running total, how long it is is that step's own
 * duration. The switch picks which of the two the numbers spell out.
 */
export const LatencyFrame = {
  /** That step's own duration, written `+963ms`. */
  Step: 'step',
  /** Elapsed since speech ended when it finished, written `1.83s`. */
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
  /** The stage labels folded into this row — the tooltip, when there is more than one. */
  members: string[];
  family: StageFamily;
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
 * stages in pipeline order, then anything past first audio out. The rows stop
 * short of the headline because the total is client-measured while the stages
 * are server-stamped — see the card's own footnote.
 */
function buildRows(group: SummaryGroup): WaterfallRow[] {
  const sorted = [...group.stages].sort((a, b) => compareStages(a.stage, b.stage));
  const rows: WaterfallRow[] = [];
  let elapsed = 0;

  // One row per subsystem, not per mark. Cascade instruments two boundaries
  // inside STT and two inside MT ("first output", then "finished"), which reads
  // as five unrelated steps unless you already know the pipeline. Summed, they
  // are the three stages the brief names. A family with a single mark keeps that
  // mark's own label — realtime has no separate STT to speak of.
  for (const { stage, stats } of sorted.filter(({ stage }) => stageScope(stage) === StageScope.Perceived)) {
    const family = stageFamily(stage);
    // Cascade's marks always read as the subsystem that owns them, even where
    // only one lands inside the window, so the rows stay parallel: speech to
    // text, translation, voice. Realtime's two marks are one model's own
    // boundaries with no subsystem to name, so they keep their labels.
    const grouped = isCascadeStage(stage) && family !== 'other';
    const open = rows.at(-1);
    if (grouped && open?.family === family) {
      open.ms += stats.medianMs;
      open.members.push(stageLabel(stage));
      open.title = open.members.join(' → ');
    } else {
      rows.push({
        key: stage,
        label: grouped ? FAMILY_LABEL[family] : stageLabel(stage),
        title: stageSpan(stage),
        members: [stageLabel(stage)],
        family,
        ms: stats.medianMs,
        startMs: elapsed,
        after: false,
      });
    }
    elapsed += stats.medianMs;
  }

  for (const { stage, stats } of sorted.filter(({ stage }) => stageScope(stage) === StageScope.AfterFirstAudio)) {
    rows.push({
      key: stage,
      label: stageLabel(stage),
      title: stageSpan(stage),
      members: [stageLabel(stage)],
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
                    style={{ left: `${pct(row.startMs)}%`, width: `${pct(row.ms)}%` }}
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
      <p className="baseline-card__note">Steps are server-timed; the total is measured at the listener.</p>
    </div>
  );
}
