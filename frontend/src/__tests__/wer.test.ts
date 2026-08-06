import { describe, expect, it } from 'vitest';
import { computeWer, groundTruthLines } from '../lab/wer';

describe('groundTruthLines', () => {
  // Catches the exact incident this exists for: pasting the benchmark doc's
  // markdown table (and the headings around it) scored the IDs, word counts,
  // and header as dropped words, inflating a clean run's WER.
  it('keeps only the spoken lines out of a pasted doc section', () => {
    const pasted = [
      '## Utterances',
      '',
      '| ID | Utterance | Words |',
      '| --- | --- | --- |',
      '| H01 | Are you allergic to any medications? | 6 |',
      '# en -> es',
      'Take one tablet twice a day with food.',
    ].join('\n');

    expect(groundTruthLines(pasted)).toEqual(['Take one tablet twice a day with food.']);
  });

  // Catches plain ground truth being mangled: the common case must survive
  // untouched apart from blank-line collapsing.
  it('passes plain lines through unchanged', () => {
    expect(groundTruthLines('Take one tablet daily.\n\nStop if swelling occurs.')).toEqual([
      'Take one tablet daily.',
      'Stop if swelling occurs.',
    ]);
  });

  // Catches a paste that produced no scorable speech reaching the runner: an
  // empty reference scores WER 1 and reads as a total model failure.
  it('yields nothing when the paste is all chrome', () => {
    expect(groundTruthLines('## Utterances\n| ID | Utterance |\n| --- | --- |')).toEqual([]);
  });

  // Catches the parse and the scorer disagreeing about what a word is — the
  // reference the user approves in the preview is the one WER divides by.
  it('feeds the scorer exactly the lines it returns', () => {
    const lines = groundTruthLines('# notes\nTake one tablet daily.\n\nStop if swelling occurs.');

    expect(computeWer(lines.join('\n'), lines.join(' ')).referenceWords).toBe(8);
  });
});

describe('computeWer', () => {
  // Catches a perfect run scoring above zero — the sanity anchor every other case builds on.
  it('scores an exact match as zero', () => {
    expect(computeWer('the quick brown fox', 'the quick brown fox').wer).toBe(0);
  });

  // Catches transcription style being punished as recognition error: case and
  // punctuation differences must not count.
  it('ignores case and punctuation differences', () => {
    const result = computeWer('Hello, how are you?', 'hello how are you');
    expect(result.wer).toBe(0);
  });

  // Catches misattributed error kinds: one wrong word in four is a 25% WER, as a substitution.
  it('counts a substitution', () => {
    const result = computeWer('the quick brown fox', 'the quick brown dog');
    expect(result).toMatchObject({ wer: 0.25, substitutions: 1, insertions: 0, deletions: 0, referenceWords: 4 });
  });

  // Catches insertions being missed: an extra hypothesis word raises WER even
  // though every reference word was recognized.
  it('counts an insertion', () => {
    const result = computeWer('all tests pass', 'all the tests pass');
    expect(result).toMatchObject({ substitutions: 0, insertions: 1, deletions: 0 });
    expect(result.wer).toBeCloseTo(1 / 3);
  });

  // Catches deletions being missed: a dropped reference word is an error.
  it('counts a deletion', () => {
    const result = computeWer('all tests pass', 'all pass');
    expect(result).toMatchObject({ substitutions: 0, insertions: 0, deletions: 1 });
    expect(result.wer).toBeCloseTo(1 / 3);
  });

  // Catches a divide-by-zero (or NaN reaching the UI) when STT produced text
  // but the reference is empty.
  it('stays total on an empty reference', () => {
    expect(computeWer('', '').wer).toBe(0);
    expect(computeWer('', 'something recognized').wer).toBe(1);
  });

  // Catches the diff view rendering errors out of order or with the wrong words:
  // the ops list must be the alignment in reading order, matches included.
  it('returns the word-by-word alignment in reading order', () => {
    const result = computeWer('take one tablet daily', 'take a tablet twice daily');

    expect(result.ops).toEqual([
      { kind: 'match', word: 'take' },
      { kind: 'substitution', reference: 'one', hypothesis: 'a' },
      { kind: 'match', word: 'tablet' },
      { kind: 'insertion', word: 'twice' },
      { kind: 'match', word: 'daily' },
    ]);
  });
});
