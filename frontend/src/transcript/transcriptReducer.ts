import type { TranscriptState, TranscriptUpdate } from './types';

/** Whitespace-only counts as no text: a silence/echo segment transcribes to `''` or `' '` and renders identically blank. */
function hasText(text: string): boolean {
  return text.trim() !== '';
}

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
 * An update carrying no text (empty or whitespace-only) never *creates* an
 * entry: providers segment audio on their own voice-activity detection, and a
 * segment that turns out to be silence or echo still gets an id and a
 * `completed` event with an empty transcript. Rendering that as a blank
 * utterance is noise, not information. An empty final for an entry that *does*
 * exist still finalizes it, keeping whatever partial text had accumulated
 * rather than blanking it.
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
    if (!update.truncated && !hasText(update.text)) return state;
    const entry = update.truncated
      ? { id: update.utteranceId, lane: update.lane, text: '', final: true, truncated: true }
      : { id: update.utteranceId, lane: update.lane, text: update.text, final: update.final };
    return { entries: [...state.entries, entry] };
  }

  const existing = state.entries[existingIndex];
  if (existing.final) {
    return state;
  }

  const settledText = hasText(update.text) ? update.text : existing.text;
  const updatedEntry = update.truncated
    ? { ...existing, final: true, truncated: true }
    : { ...existing, text: update.final ? settledText : existing.text + update.text, final: update.final };
  const entries = [...state.entries];
  entries[existingIndex] = updatedEntry;
  return { entries };
}
