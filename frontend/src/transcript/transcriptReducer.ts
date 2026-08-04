import type { TranscriptState, TranscriptUpdate } from './types';

/**
 * Applies one {@link TranscriptUpdate} to transcript state, immutably.
 *
 * Updates are keyed by `utteranceId`, not by arrival order, so interleaved
 * deltas for different utterances (e.g. a source partial arriving between
 * two target partials) each land on their own entry rather than corrupting
 * whichever entry happens to be "current". A first update for an id creates
 * its entry (utterance grouping); later updates for the same id append
 * (partial) or replace (final) that entry's text in place. Updates that
 * arrive after an utterance has already been finalized are ignored, since a
 * provider has no reason to keep talking about a completed utterance and a
 * stray late event shouldn't reopen or corrupt already-settled text.
 *
 * A `truncated: true` update (issue #11 — a barge-in cut this utterance
 * short) is handled separately from the append/replace logic above: it
 * finalizes the entry and marks it truncated *without* touching `text` at
 * all, whether or not any text had accumulated yet. This is deliberate — the
 * backend's `transcript.truncated` envelope carries only an id, no text, so
 * there is nothing to append or replace; the existing (possibly empty,
 * possibly partial) text is exactly what should be left on screen, just
 * marked "cut off" instead of "in progress" forever.
 *
 * Pure and transport-agnostic: usable directly as a React `useReducer`
 * reducer, or driven by hand in tests, regardless of which mode's adapter
 * produced the update.
 */
export function transcriptReducer(state: TranscriptState, update: TranscriptUpdate): TranscriptState {
  const existingIndex = state.entries.findIndex((entry) => entry.id === update.utteranceId);

  if (existingIndex === -1) {
    const entry = update.truncated
      ? { id: update.utteranceId, lane: update.lane, text: '', final: true, truncated: true }
      : { id: update.utteranceId, lane: update.lane, text: update.text, final: update.final };
    return { entries: [...state.entries, entry] };
  }

  const existing = state.entries[existingIndex];
  if (existing.final) {
    return state;
  }

  const updatedEntry = update.truncated
    ? { ...existing, final: true, truncated: true }
    : { ...existing, text: update.final ? update.text : existing.text + update.text, final: update.final };
  const entries = [...state.entries];
  entries[existingIndex] = updatedEntry;
  return { entries };
}
