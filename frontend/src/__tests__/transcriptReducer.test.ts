import { describe, expect, it } from 'vitest';
import { transcriptReducer } from '../transcript/transcriptReducer';
import { INITIAL_TRANSCRIPT_STATE } from '../transcript/types';
import type { TranscriptUpdate } from '../transcript/types';

describe('transcriptReducer', () => {
  // Catches the bug where the first delta of a new utterance either gets
  // dropped or duplicated instead of appearing as one in-progress entry.
  it('creates a new in-progress entry from the first partial update', () => {
    const update: TranscriptUpdate = { utteranceId: 'a', lane: 'source', text: 'Hel', final: false };

    const state = transcriptReducer(INITIAL_TRANSCRIPT_STATE, update);

    expect(state.entries).toEqual([{ id: 'a', lane: 'source', text: 'Hel', final: false }]);
  });

  // Catches the bug where a live-updating transcript re-renders as separate lines per
  // delta instead of one growing utterance (breaks "entries render incrementally" +
  // utterance grouping from the issue).
  it('appends successive partial deltas to the same entry rather than creating new ones', () => {
    let state = transcriptReducer(INITIAL_TRANSCRIPT_STATE, {
      utteranceId: 'a',
      lane: 'source',
      text: 'Hel',
      final: false,
    });
    state = transcriptReducer(state, { utteranceId: 'a', lane: 'source', text: 'lo', final: false });

    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toEqual({ id: 'a', lane: 'source', text: 'Hello', final: false });
  });

  // Catches the bug where finalizing an utterance either appends the provider's full
  // final transcript on top of already-accumulated deltas (duplicating text) or leaves
  // the entry stuck showing `final: false` forever (so it never gets the "settled"
  // styling and looks perpetually in-progress).
  it('replaces accumulated text with the full transcript and marks the entry final on completion', () => {
    let state = transcriptReducer(INITIAL_TRANSCRIPT_STATE, {
      utteranceId: 'a',
      lane: 'source',
      text: 'Hel',
      final: false,
    });
    state = transcriptReducer(state, { utteranceId: 'a', lane: 'source', text: 'Hello there', final: true });

    expect(state.entries).toEqual([{ id: 'a', lane: 'source', text: 'Hello there', final: true }]);
  });

  // Catches a corruption bug: interleaved deltas for two different utterances (e.g. a
  // source partial arriving between two target partials, as happens when the caller
  // keeps talking while the interpretation is still streaming) must land on their own
  // entries, keyed by id, instead of one lane's text bleeding into the other's.
  it('keeps interleaved updates for different utterances and lanes from corrupting each other', () => {
    let state = INITIAL_TRANSCRIPT_STATE;
    state = transcriptReducer(state, { utteranceId: 'src-1', lane: 'source', text: 'Hola', final: false });
    state = transcriptReducer(state, { utteranceId: 'tgt-1', lane: 'target', text: 'Hel', final: false });
    state = transcriptReducer(state, { utteranceId: 'src-1', lane: 'source', text: ' amigo', final: false });
    state = transcriptReducer(state, { utteranceId: 'tgt-1', lane: 'target', text: 'lo', final: false });

    expect(state.entries).toEqual([
      { id: 'src-1', lane: 'source', text: 'Hola amigo', final: false },
      { id: 'tgt-1', lane: 'target', text: 'Hello', final: false },
    ]);
  });

  // Catches an out-of-order bug: an utterance's finalizing event overtaking a straggling
  // delta (both are separate data-channel messages; nothing guarantees delivery order)
  // must not reopen or corrupt text that already settled as final.
  it('ignores an update that arrives for an utterance that already finalized', () => {
    let state = transcriptReducer(INITIAL_TRANSCRIPT_STATE, {
      utteranceId: 'a',
      lane: 'source',
      text: 'Hello',
      final: true,
    });
    state = transcriptReducer(state, { utteranceId: 'a', lane: 'source', text: ' there', final: false });

    expect(state.entries).toEqual([{ id: 'a', lane: 'source', text: 'Hello', final: true }]);
  });

  // Catches a shared-reference mutation bug: the reducer must return a new entries
  // array/object rather than mutating the previous state in place, since React (and
  // any test asserting on a captured previous snapshot) relies on immutability to
  // detect changes.
  it('does not mutate the previous state object', () => {
    const previous = transcriptReducer(INITIAL_TRANSCRIPT_STATE, {
      utteranceId: 'a',
      lane: 'source',
      text: 'Hi',
      final: false,
    });
    const previousEntriesSnapshot = [...previous.entries];

    transcriptReducer(previous, { utteranceId: 'a', lane: 'source', text: '!', final: true });

    expect(previous.entries).toEqual(previousEntriesSnapshot);
  });
});
