/**
 * Word Error Rate (Lab P3): word-level edit distance of the STT output against
 * a ground-truth reference, after normalization — the brief's stated accuracy
 * metric. Pure so it runs under plain Vitest.
 */

export interface WerResult {
  /** (substitutions + insertions + deletions) / reference word count. Can exceed 1 with enough insertions. */
  wer: number;
  substitutions: number;
  insertions: number;
  deletions: number;
  referenceWords: number;
}

/**
 * Lowercases, strips punctuation (keeping letters, digits, and in-word
 * apostrophes), and splits to words — so "Hello, world!" and "hello world"
 * score identically. Case and punctuation are transcription style, not
 * recognition errors.
 */
export function normalizeForWer(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Computes WER via the standard dynamic-programming edit distance, tracking
 * the three error kinds separately.
 *
 * An empty reference scores 0 against an empty hypothesis and 1 against a
 * non-empty one (every hypothesis word is an insertion against nothing) —
 * callers should treat an empty reference as a validation error before
 * scoring, but the function stays total.
 */
export function computeWer(reference: string, hypothesis: string): WerResult {
  const ref = normalizeForWer(reference);
  const hyp = normalizeForWer(hypothesis);

  if (ref.length === 0) {
    return { wer: hyp.length === 0 ? 0 : 1, substitutions: 0, insertions: hyp.length, deletions: 0, referenceWords: 0 };
  }

  // cost[i][j] = edit distance between ref[0..i) and hyp[0..j).
  const cost: number[][] = Array.from({ length: ref.length + 1 }, () => new Array<number>(hyp.length + 1).fill(0));
  for (let i = 0; i <= ref.length; i++) cost[i][0] = i;
  for (let j = 0; j <= hyp.length; j++) cost[0][j] = j;
  for (let i = 1; i <= ref.length; i++) {
    for (let j = 1; j <= hyp.length; j++) {
      const substitution = cost[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      cost[i][j] = Math.min(substitution, cost[i - 1][j] + 1, cost[i][j - 1] + 1);
    }
  }

  // Backtrace to attribute the distance to substitutions/insertions/deletions.
  let substitutions = 0;
  let insertions = 0;
  let deletions = 0;
  let i = ref.length;
  let j = hyp.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && cost[i][j] === cost[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      if (ref[i - 1] !== hyp[j - 1]) substitutions++;
      i--;
      j--;
    } else if (j > 0 && cost[i][j] === cost[i][j - 1] + 1) {
      insertions++;
      j--;
    } else {
      deletions++;
      i--;
    }
  }

  return {
    wer: (substitutions + insertions + deletions) / ref.length,
    substitutions,
    insertions,
    deletions,
    referenceWords: ref.length,
  };
}
