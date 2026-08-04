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
  /**
   * True if this utterance was cut short by a barge-in (issue #11) rather
   * than reaching a natural `transcript.final`/`.done`. Omitted (rather
   * than `false`) on every entry that never got a truncation update, so
   * existing entry-shape assertions that predate this field keep passing —
   * `toEqual` treats a missing key the same as one explicitly set to
   * `undefined`.
   */
  truncated?: boolean;
}

/**
 * A single incremental update to one utterance, produced by a mode-specific
 * adapter (e.g. `realtimeTranscriptAdapter`) from that mode's raw events.
 *
 * When `final` is `false`, `text` is a *delta* to append to whatever has
 * accumulated for `utteranceId` so far. When `final` is `true`, `text` is
 * the utterance's complete, canonical text (providers typically resend the
 * full transcript on completion), which replaces rather than appends.
 *
 * When `truncated` is `true` (issue #11, a barge-in cut this utterance
 * short), `text` is ignored entirely by the reducer — there is no new text,
 * just a marker that finalizes whatever text already accumulated. Adapters
 * emitting a truncation update pass an empty string for `text` and
 * `final: true` for shape-completeness, but the reducer never reads either
 * off a truncated update. See `transcriptReducer.ts`.
 */
export interface TranscriptUpdate {
  /** Stable id grouping every update that belongs to the same utterance. */
  utteranceId: string;
  lane: TranscriptLane;
  text: string;
  final: boolean;
  truncated?: boolean;
}

/** All transcript entries accumulated so far, in the order each utterance first appeared. */
export interface TranscriptState {
  entries: TranscriptEntry[];
}

/** The state a fresh session (or a restarted one) starts from. */
export const INITIAL_TRANSCRIPT_STATE: TranscriptState = { entries: [] };
