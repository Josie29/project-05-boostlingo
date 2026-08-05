import type { LatencyReport, LatencySessionAverages, LatencyState, LatencyStageTiming } from './types';
import { EMPTY_LATENCY_AVERAGES } from './types';

/** How many of the most recently appeared utterances' full breakdowns the panel shows at once. */
export const MAX_RECENT_LATENCY_REPORTS = 5;

/**
 * Applies one utterance's (possibly updated) {@link LatencyReport} to
 * latency state, immutably — same "keyed by id, replace in place" shape as
 * `transcriptReducer`. A report for an `utteranceId` already present
 * replaces that entry in place (a cascade utterance's report fills in as
 * more marks arrive over the utterance's lifetime); a new `utteranceId` is
 * appended.
 *
 * Pure and transport-agnostic: usable directly as a React `useReducer`
 * reducer, or driven by hand in tests, regardless of which mode's adapter
 * produced the report.
 */
export function latencyReducer(state: LatencyState, report: LatencyReport): LatencyState {
  const existingIndex = state.reports.findIndex((existing) => existing.utteranceId === report.utteranceId);

  if (existingIndex === -1) {
    return { reports: [...state.reports, report] };
  }

  const reports = [...state.reports];
  reports[existingIndex] = report;
  return { reports };
}

/**
 * The most recently appeared {@link MAX_RECENT_LATENCY_REPORTS} utterances'
 * reports, oldest first — what the panel's per-utterance breakdown table
 * renders. Older utterances fall off the *display* list only; they still
 * count toward {@link selectLatencyAverages}.
 */
export function selectRecentReports(state: LatencyState, limit: number = MAX_RECENT_LATENCY_REPORTS): LatencyReport[] {
  return state.reports.slice(-limit);
}

/**
 * Session-wide running averages, recomputed from every report accumulated
 * so far (not just the recent-N display window). Recomputing from scratch
 * rather than maintaining a running sum avoids double-counting an utterance
 * whose report has been replaced in place multiple times as later marks
 * arrived — the alternative (incrementally folding each update into a
 * running total) would count the same utterance's earlier, partial numbers
 * again every time a new mark for it lands.
 *
 * `filter` narrows which reports contribute (the per-mode scoreboard passes
 * a mode predicate over the namespaced utteranceId); omitted, every report
 * counts, exactly as before.
 */
export function selectLatencyAverages(
  state: LatencyState,
  filter?: (report: LatencyReport) => boolean,
): LatencySessionAverages {
  const reports = filter ? state.reports.filter(filter) : state.reports;
  if (reports.length === 0) return EMPTY_LATENCY_AVERAGES;

  const stageSums = new Map<string, { total: number; count: number }>();
  const endToEndValues: number[] = [];

  for (const report of reports) {
    if (report.endToEndMs !== null) endToEndValues.push(report.endToEndMs);
    for (const { stage, ms } of report.stages) {
      const sum = stageSums.get(stage) ?? { total: 0, count: 0 };
      sum.total += ms;
      sum.count += 1;
      stageSums.set(stage, sum);
    }
  }

  const stageAverages: LatencyStageTiming[] = [...stageSums.entries()].map(([stage, { total, count }]) => ({
    stage,
    ms: total / count,
  }));

  return {
    sampleCount: reports.length,
    stageAverages,
    endToEndAverageMs:
      endToEndValues.length > 0 ? endToEndValues.reduce((sum, value) => sum + value, 0) / endToEndValues.length : null,
  };
}
