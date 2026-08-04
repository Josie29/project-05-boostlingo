/**
 * Mode-agnostic latency domain (issue #10). Nothing here knows about cascade
 * wire envelopes or Realtime data-channel/WebRTC events — each transport's
 * own adapter (`cascadeLatencyAdapter.ts`, `realtimeLatencyAdapter.ts`) folds
 * its own raw signals into these shapes, so `LatencyPanel` (and the reducer/
 * selectors below) never need to know which mode produced a report. Stage
 * names are opaque strings to every consumer here — only the cascade
 * adapter's internal stage-ordering logic (`cascadeStages.ts`) assigns any
 * meaning to a particular name.
 */

/** One pipeline stage's duration since the nearest earlier stage this report has a mark for, in milliseconds. */
export interface LatencyStageTiming {
  stage: string;
  ms: number;
}

/**
 * One utterance's latency breakdown. `stages` only ever contains entries
 * this transport actually observed a boundary for — a stage with no mark
 * (dropped, not yet arrived, or simply not instrumented by this transport)
 * is omitted entirely, never reported as a zero or `NaN` placeholder.
 */
export interface LatencyReport {
  /** Stable id grouping every stage/timing update for one utterance — namespaced per-mode by `prefixId`, mirroring `TranscriptUpdate.utteranceId`. */
  utteranceId: string;
  stages: LatencyStageTiming[];
  /** Perceived end-to-end latency (speech end -> audio audible), ms, or `null` until enough of it is known. */
  endToEndMs: number | null;
}

/** All latency reports accumulated so far, in the order each utterance first appeared — mirrors `TranscriptState`. */
export interface LatencyState {
  reports: LatencyReport[];
}

/** The state a fresh session (or a restarted one) starts from. */
export const INITIAL_LATENCY_STATE: LatencyState = { reports: [] };

/** Running "how's this session doing overall" stats, recomputed from every report accumulated so far. */
export interface LatencySessionAverages {
  /** How many utterances have contributed at least one report so far. */
  sampleCount: number;
  /** Mean of each stage's ms across every report that had that stage — the set of stages present grows as new ones are observed. */
  stageAverages: LatencyStageTiming[];
  /** Mean `endToEndMs` across every report that had one, or `null` if none has yet. */
  endToEndAverageMs: number | null;
}

/** The averages a session with no reports yet starts from. */
export const EMPTY_LATENCY_AVERAGES: LatencySessionAverages = {
  sampleCount: 0,
  stageAverages: [],
  endToEndAverageMs: null,
};
