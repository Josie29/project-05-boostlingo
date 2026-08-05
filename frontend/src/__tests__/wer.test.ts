import { describe, expect, it } from 'vitest';
import { computeWer } from '../lab/wer';

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
});
