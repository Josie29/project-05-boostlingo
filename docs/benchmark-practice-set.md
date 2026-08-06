# Benchmark practice set — healthcare, 3 utterances

Small set for rehearsing the run loop and the scoring pipeline before spending
a full session on [benchmark-script.md](benchmark-script.md). One pass is about
25 seconds.

Healthcare is Boostlingo's largest vertical, and clinical instructions are the
case where a mistranslation is a safety error rather than a style one — the
class their own materials say human interpreters remain preferable for.

## Utterances

| ID | Utterance | Words |
| --- | --- | --- |
| H01 | Are you allergic to any medications? | 6 |
| H02 | I have been having sharp chest pain for about three days, and it gets worse when I climb stairs or carry groceries. | 22 |
| H03 | Take one tablet twice a day with food, and if you notice swelling in your face or trouble breathing, stop the medication and go to the emergency room. | 28 |

Read in order, pause ~2 seconds between each, press Stop at the end.

## Paste this into the Lab

The Lab's ground-truth box takes plain lines only — one utterance per line, in
spoken order, blank lines and `#` comments ignored. Table rows are dropped, so
copy this block, not the table above. Check the utterance and word counts the
box reports before you run — a reference missing part of what was said scores
the rest as insertions, and WER climbs past 100% looking like a model failure.

```
Are you allergic to any medications?

I have been having sharp chest pain for about three days, and it gets worse when I climb stairs or carry groceries.

Take one tablet twice a day with food, and if you notice swelling in your face or trouble breathing, stop the medication and go to the emergency room.
```

## Ground truth format

Save as `benchmark-practice-set.json` when wiring up a scorer. `order` is
load-bearing — see alignment below.

```json
{
  "set_id": "healthcare-practice-v1",
  "source_lang": "en",
  "target_lang": "es",
  "utterances": [
    {
      "id": "H01",
      "order": 1,
      "class": "short",
      "reference": "Are you allergic to any medications?"
    },
    {
      "id": "H02",
      "order": 2,
      "class": "long",
      "reference": "I have been having sharp chest pain for about three days, and it gets worse when I climb stairs or carry groceries."
    },
    {
      "id": "H03",
      "order": 3,
      "class": "long",
      "reference": "Take one tablet twice a day with food, and if you notice swelling in your face or trouble breathing, stop the medication and go to the emergency room."
    }
  ]
}
```

## Pulling the hypotheses

```sql
SELECT text FROM transcript_entries
WHERE conversation_id = ? AND lane = 'source'
  AND utterance_id LIKE 'cascade:%'
ORDER BY rowid;
```

## Alignment — the part that bites

`transcript_entries.utterance_id` is a provider-assigned opaque id
(`cascade:item_E9aXoXWNgIVL6nkwYACDV`), so **references cannot be joined to
hypotheses by id**. They align by position only.

The schema has no sequence column and no per-utterance timestamp, so ordering
depends on SQLite `rowid`, which reflects insert order, which reflects report
order. Verified correct against captured data, but it is an implicit contract
rather than a guaranteed one. A `sequence` column on `utterances` would make
this robust — worth adding if scoring becomes routine.

Practical consequences:

- Do not skip, repeat, or reorder lines mid-run.
- **Assert `count(hypotheses) == count(references)` before scoring.** If they
  differ, align by hand — silent misalignment scores every subsequent line
  against the wrong reference and produces a WER near 100% that looks like a
  model failure.
- A line can legitimately produce no row. An utterance whose translation comes
  back empty stops at `mtFinal` with a `NULL` end-to-end (see
  [cascade-walkthrough.md](cascade-walkthrough.md)); filter target-lane rows
  and treat a missing source row as a dropped utterance, not a shift.
- Filter to one mode. A session with a mid-session mode switch interleaves
  `cascade:` and `realtime:` prefixed ids in the same conversation.

## Normalization before WER

Apply to both sides, or formatting differences score as recognition errors:

- Lowercase; strip punctuation.
- Normalize numerals in one direction — "three days" vs "3 days", "one tablet"
  vs "1 tablet" are the live cases in this set.
- Collapse whitespace.

## What to watch per line

| ID | Watch for |
| --- | --- |
| H01 | Baseline — a short, common clinical question. If this line has errors, something is wrong with audio capture, not the model. |
| H02 | First-person symptom description with a duration ("three days"). Tests the numeral normalization path. |
| H03 | Safety-critical. Check the Spanish for dosage ("one tablet twice a day") and the conditional ("if you notice... stop") surviving intact. A dropped negation or a mangled dose is the failure mode that matters, and it will not show up in WER at all — WER scores the *source* transcript. Read this one by ear. |

That last row is the point of the practice run: WER measures STT, not
translation. Confirming that requires listening, and this set is short enough
to listen to properly.
