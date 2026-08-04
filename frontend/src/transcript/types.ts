/**
 * Mode-agnostic transcript domain. Nothing in this module knows about
 * WebRTC, data channels, or any particular transport — Realtime mode and
 * the future cascade pipeline both adapt their own events into
 * {@link TranscriptUpdate}s and feed the same reducer, so
 * {@link TranscriptPanel} (and its tests) never need to know which mode
 * produced the text.
 */

/** Which column an utterance belongs in: what was said vs. its interpretation. */
export type TranscriptLane = 'source' | 'target';

/** One utterance's running text in a lane, as rendered by the transcript panel. */
export interface TranscriptEntry {
  /** Stable id for the utterance; groups every update for one utterance into one entry. */
  id: string;
  lane: TranscriptLane;
  text: string;
  /** False while more text is still expected (partial/in-progress); true once the utterance is done. */
  final: boolean;
}

/**
 * A single incremental update to one utterance, produced by a mode-specific
 * adapter (e.g. `realtimeTranscriptAdapter`) from that mode's raw events.
 *
 * When `final` is `false`, `text` is a *delta* to append to whatever has
 * accumulated for `utteranceId` so far. When `final` is `true`, `text` is
 * the utterance's complete, canonical text (providers typically resend the
 * full transcript on completion), which replaces rather than appends.
 */
export interface TranscriptUpdate {
  /** Stable id grouping every update that belongs to the same utterance. */
  utteranceId: string;
  lane: TranscriptLane;
  text: string;
  final: boolean;
}

/** All transcript entries accumulated so far, in the order each utterance first appeared. */
export interface TranscriptState {
  entries: TranscriptEntry[];
}

/** The state a fresh session (or a restarted one) starts from. */
export const INITIAL_TRANSCRIPT_STATE: TranscriptState = { entries: [] };
