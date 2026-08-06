# WER evaluation — how the ground-truth scoring works

How the Lab's experiment runner scores a fixture run. Implementation:
`frontend/src/lab/wer.ts`; invoked by `frontend/src/lab/experimentRunner.ts`.

## Inputs

- **Reference** — the ground-truth text pasted into the run form: what was
  actually said in the recording (source language).
- **Hypothesis** — what STT wrote down: every source-lane transcript entry
  from the run, joined in order.

## Normalization

Both texts get the same cleanup before comparison, so transcription *style*
never counts as recognition *error*:

1. Unicode NFKC normalization (a curly apostrophe equals a plain one).
2. Lowercase.
3. Punctuation replaced with spaces, except apostrophes inside words
   ("don't" stays one word).
4. Split on whitespace into word lists. WER only ever compares words.

## Scoring: minimum-edit alignment

The score asks: what is the fewest number of single-word fixes that turns the
hypothesis into the reference? Three fix kinds, each costing 1:

| Fix | Meaning | Example (ref → hyp) |
| --- | --- | --- |
| Substitution | wrong word | `fox` → `dog` |
| Insertion | word nobody said | `all tests pass` → `all the tests pass` |
| Deletion | dropped word | `all tests pass` → `all pass` |

Position-by-position comparison would misgrade everything after one dropped
word, so the minimum is found with the standard Levenshtein edit-distance
dynamic program: a grid where cell (i, j) = fewest fixes turning the first j
hypothesis words into the first i reference words, each cell the cheapest of
diagonal (+0 match / +1 substitution), left (+1 insertion), and above
(+1 deletion). The bottom-right cell is the total; a backtrace through the
grid attributes it to the three kinds.

## The score

```
WER = (substitutions + insertions + deletions) / reference word count
```

- `all tests pass` vs `all the tests pass` → 1 insertion / 3 words → 33.3%.
- Can exceed 100% (insertions have no ceiling); denominator is always the
  reference. Standard definition.
- Empty reference scores 0 against an empty hypothesis, 1 against anything
  else (no divide-by-zero); the run form requires ground truth anyway.

## What it deliberately does not measure

- **Translation quality** — WER grades the cascade's STT stage against the
  source-language reference only. Scoring MT output would need a
  target-language reference and a different metric (BLEU/COMET); noted as
  future work rather than faked with WER.
- **Timing** — latency has its own columns; one score, one stage, on purpose.
- Realtime mode — the runner is cascade-only today, so no realtime WER yet.
