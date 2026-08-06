/**
 * Word Error Rate (Lab P3): word-level edit distance of the STT output against
 * a ground-truth reference, after normalization — the brief's stated accuracy
 * metric. Pure so it runs under plain Vitest.
 */

/** One step of the alignment, in reading order — what the diff view renders. Words are the normalized tokens. */
export type WerOp =
  | { kind: 'match'; word: string }
  | { kind: 'substitution'; reference: string; hypothesis: string }
  | { kind: 'insertion'; word: string }
  | { kind: 'deletion'; word: string };

export interface WerResult {
  /** (substitutions + insertions + deletions) / reference word count. Can exceed 1 with enough insertions. */
  wer: number;
  substitutions: number;
  insertions: number;
  deletions: number;
  referenceWords: number;
  /** The full word-by-word alignment, in reading order. */
  ops: WerOp[];
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
 * Splits pasted ground truth into the utterances to score: one per line in
 * spoken order, with blank lines, `#` comments (which is also how a pasted
 * markdown heading arrives), and `|` table rows dropped.
 *
 * The single seam between what the preview shows and what gets scored — both
 * call this, so they cannot disagree.
 */
export function groundTruthLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('|'));
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
    return {
      wer: hyp.length === 0 ? 0 : 1,
      substitutions: 0,
      insertions: hyp.length,
      deletions: 0,
      referenceWords: 0,
      ops: hyp.map((word) => ({ kind: 'insertion', word })),
    };
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

  // Backtrace to attribute the distance to substitutions/insertions/deletions
  // and record the word-by-word alignment the diff view renders.
  const ops: WerOp[] = [];
  let substitutions = 0;
  let insertions = 0;
  let deletions = 0;
  let i = ref.length;
  let j = hyp.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && cost[i][j] === cost[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      if (ref[i - 1] !== hyp[j - 1]) {
        substitutions++;
        ops.push({ kind: 'substitution', reference: ref[i - 1], hypothesis: hyp[j - 1] });
      } else {
        ops.push({ kind: 'match', word: ref[i - 1] });
      }
      i--;
      j--;
    } else if (j > 0 && cost[i][j] === cost[i][j - 1] + 1) {
      insertions++;
      ops.push({ kind: 'insertion', word: hyp[j - 1] });
      j--;
    } else {
      deletions++;
      ops.push({ kind: 'deletion', word: ref[i - 1] });
      i--;
    }
  }
  ops.reverse();

  return {
    wer: (substitutions + insertions + deletions) / ref.length,
    substitutions,
    insertions,
    deletions,
    referenceWords: ref.length,
    ops,
  };
}
