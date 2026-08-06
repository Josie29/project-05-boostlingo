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

  // Catches the bug where a provider's own VAD segments silence or its own
  // echo into an utterance, transcribes it to nothing, and the panel renders a
  // blank row between two real utterances (observed in a live Realtime run).
  it('drops a textless update for an utterance it has never seen', () => {
    let state = transcriptReducer(INITIAL_TRANSCRIPT_STATE, { utteranceId: 'a', lane: 'source', text: '', final: true });
    state = transcriptReducer(state, { utteranceId: 'b', lane: 'source', text: '', final: false });
    state = transcriptReducer(state, { utteranceId: 'c', lane: 'source', text: '  ', final: true });

    expect(state.entries).toEqual([]);
  });

  // Catches the bug where a provider that resends nothing on completion (an
  // empty final after real deltas) blanks text the listener already read.
  it('keeps accumulated text when a final update carries none', () => {
    let state = transcriptReducer(INITIAL_TRANSCRIPT_STATE, {
      utteranceId: 'a',
      lane: 'source',
      text: 'Hello',
      final: false,
    });
    state = transcriptReducer(state, { utteranceId: 'a', lane: 'source', text: '', final: true });

    expect(state.entries).toEqual([{ id: 'a', lane: 'source', text: 'Hello', final: true }]);
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

  describe('truncated updates (issue #11)', () => {
    // Catches the core bug this issue is about: a barge-in cutting off an
    // in-progress utterance must leave its already-accumulated text on screen
    // (not blank it out) while finalizing it and marking it "cut off" — a
    // listener re-reading the transcript later needs to see what was actually
    // said before the interruption, not an empty entry.
    it('finalizes an in-progress entry and marks it truncated, preserving its accumulated text', () => {
      let state = transcriptReducer(INITIAL_TRANSCRIPT_STATE, {
        utteranceId: 'a',
        lane: 'target',
        text: 'Hel',
        final: false,
      });
      state = transcriptReducer(state, { utteranceId: 'a', lane: 'target', text: '', final: true, truncated: true });

      expect(state.entries).toEqual([{ id: 'a', lane: 'target', text: 'Hel', final: true, truncated: true }]);
    });

    // Catches a text-clobbering bug: since transcript.truncated carries no text of
    // its own, the reducer must ignore whatever's on the update's `text` field
    // entirely (not treat it as a final replacement, which would blank the entry).
    it('ignores the truncated update\'s own text field even if non-empty', () => {
      let state = transcriptReducer(INITIAL_TRANSCRIPT_STATE, {
        utteranceId: 'a',
        lane: 'target',
        text: 'Hello the',
        final: false,
      });
      state = transcriptReducer(state, {
        utteranceId: 'a',
        lane: 'target',
        text: 'this should be ignored',
        final: true,
        truncated: true,
      });

      expect(state.entries[0].text).toBe('Hello the');
    });

    // Catches a crash/edge-case bug: a truncation for an utterance this reducer
    // never saw any prior update for (e.g. one superseded before its first
    // partial ever arrived) must still produce a valid, empty-but-final entry
    // rather than throwing or being silently dropped.
    it('creates an empty, final, truncated entry when no prior update exists for the utterance', () => {
      const state = transcriptReducer(INITIAL_TRANSCRIPT_STATE, {
        utteranceId: 'a',
        lane: 'target',
        text: 'ignored',
        final: true,
        truncated: true,
      });

      expect(state.entries).toEqual([{ id: 'a', lane: 'target', text: '', final: true, truncated: true }]);
    });

    // Catches a bug where a truncation racing an utterance's own natural
    // completion reopens or corrupts already-settled text — mirrors the
    // existing "ignores an update for an already-finalized utterance" guard
    // above, but specifically for the truncated path.
    it('ignores a truncation for an utterance that already finalized naturally', () => {
      let state = transcriptReducer(INITIAL_TRANSCRIPT_STATE, {
        utteranceId: 'a',
        lane: 'target',
        text: 'Hello',
        final: true,
      });
      state = transcriptReducer(state, { utteranceId: 'a', lane: 'target', text: '', final: true, truncated: true });

      expect(state.entries).toEqual([{ id: 'a', lane: 'target', text: 'Hello', final: true }]);
    });
  });
});
