# Benchmark script — English → Spanish

Fixed utterance set spoken identically into every benchmark run, so that
[benchmarks.md](benchmarks.md)'s latency, cost, and accuracy figures compare
architectures rather than compare whatever happened to get said. It doubles as
the ground-truth reference for Word Error Rate (WER): the source-lane text in
`transcript_entries` is scored against the lines below.

## Why fixed content

Free-form speech confounds four variables at once, and at the sample sizes a
5-minute run produces (~40 utterances) that variance is larger than the
architectural difference being measured:

| Confound | What it corrupts |
| --- | --- |
| Utterance length | STT decode time, MT token count, TTS audio duration — end-to-end latency *and* cost |
| Phrasing / semantic completeness | `semantic_vad` commit timing, which starts the latency clock |
| Vocabulary difficulty | STT accuracy, so WER |
| Output length | TTS cost (billed per second of output audio) and `ttsEnd` |

## Why English-only source

Realtime mode interprets both directions within a single session
(`RealtimeSession.cs:109`); cascade mode fixes one target language for the
session's lifetime, because the TTS stage picks its voice from that language
(`OpenAiTtsProvider.ResolveVoice`). Speaking Spanish into a cascade session
configured `en → es` feeds Spanish audio to an STT stream configured for
English and produces garbage.

So every line here is English. Testing the reverse direction means a second
cascade session configured `es → en`, which is out of scope for the primary
comparison — but the asymmetry itself belongs in
[comparison.md](comparison.md)'s controllability section.

## How to run it

1. Read at a normal conversational pace. Do not memorize — read, so pass three
   sounds like pass one.
2. Pause about two seconds between utterances, so VAD boundaries are
   unambiguous and one utterance's synthesized audio does not overlap the next
   one's speech.
3. One pass is roughly 2.5 minutes. **Run two passes per session** to reach the
   brief's 5-minute stability requirement; that also doubles the latency sample
   to ~40 utterances.
4. Press Stop at the end — that is what persists the run to SQLite.
5. Run barge-in tests and the mid-session mode switch as a *separate* short
   session. Barge-ins deliberately abort utterances mid-pipeline, and those
   rows would drag the medians in your clean sample.

For the strongest isolation, record one pass and play it back through a virtual
audio device (`brew install --cask blackhole-2ch`, then select BlackHole as the
microphone in Chrome). Every run then receives bit-identical audio rather than
merely identical words.

## Section A — clinical encounter

Boostlingo's largest vertical is healthcare, and this is the register their
on-demand interpreter network actually serves.

| ID | Utterance | Words |
| --- | --- | --- |
| A01 | Where does it hurt? | 4 |
| A02 | How long has this been going on? | 7 |
| A03 | Are you allergic to any medications? | 6 |
| A04 | Please take a deep breath and hold it. | 8 |
| A05 | I have been having sharp pain in my lower back for about three weeks, and it gets worse when I try to stand up from a chair. | 27 |
| A06 | Do you have your insurance card? | 6 |
| A07 | Before we can schedule the procedure, I need you to stop taking aspirin for seven days, and you should not eat or drink anything after midnight the night before. | 29 |
| A08 | Your appointment is on March fourteenth at two forty-five in the afternoon with Doctor Ramirez. | 15 |
| A09 | I need to check your blood pressure. | 7 |
| A10 | This medication should be taken twice daily with food, and if you notice any swelling in your face or throat, stop taking it and call us immediately. | 27 |
| A11 | The pharmacy is at fourteen twenty Guadalupe Street, and your prescription number is eight three seven two nine. | 18 |
| A12 | Do you understand everything I explained? | 6 |
| A13 | My daughter Marisol was born on November second, two thousand nineteen, at Saint David's Medical Center in Austin. | 18 |
| A14 | I will get an interpreter now. | 6 |

## Section B — business and events register

Boostlingo also sells remote simultaneous interpretation (RSI) and AI live
captioning into conferences and corporate meetings, so this register is a real
product surface rather than filler. The content doubles as company background.

| ID | Utterance | Words |
| --- | --- | --- |
| B01 | Which language do you need? | 5 |
| B02 | Boostlingo connects organizations with more than ten thousand qualified interpreters across two hundred seventy-five languages, with an average response time of about five seconds. | 24 |
| B03 | In twenty twenty-two the company acquired Interpreter Intelligence for interpretation management and VoiceBoxer for remote simultaneous interpreting, bringing phone, video, on-site, and conference formats onto one platform. | 28 |
| B04 | The transcript will be ready shortly. | 6 |
| B05 | Their AI Pro product delivers live translated captions and speech in over one hundred thirty languages, with reported accuracy between ninety and ninety-eight percent depending on audio quality. | 28 |
| B06 | A recent company report found that three in four healthcare leaders would turn to AI interpreting when human interpreter wait times reach five minutes. | 24 |

## Composition

| Class | Count | IDs |
| --- | --- | --- |
| Short (≤ 8 words) | 10 | A01–A04, A06, A09, A12, A14, B01, B04 |
| Long (≥ 20 words) | 7 | A05, A07, A10, B02, B03, B05, B06 |
| Numeric / proper-noun heavy | 3 | A08, A11, A13 |

Short utterances expose fixed per-utterance overhead — connection turnaround,
VAD commit delay, time-to-first-token — because there is almost no audio to
decode. Long utterances expose throughput and streaming behavior: whether MT
starts emitting before STT finalizes, and whether TTS starts before MT
completes. Both classes are needed; reporting only one hides half the story.

## Scoring notes

**Normalize before computing WER.** Spoken numbers come back as digits from
some models and as words from others: A08 may transcribe as "March 14th at
2:45" against a reference reading "March fourteenth at two forty-five". Scored
raw, that is six word errors caused by formatting rather than recognition.
Normalize both sides — lowercase, strip punctuation, expand or collapse
numerals consistently — before aligning.

**Lines expected to break first.** Worth watching individually rather than only
in the aggregate:

| ID | Hazard |
| --- | --- |
| A08, A11 | Digit strings and times — the normalization case above |
| A11, A13 | Spanish-origin proper nouns inside English speech (*Guadalupe*, *Marisol*), where an English-configured STT stream is least confident |
| A13 | Possessive proper noun (*Saint David's*) plus a date |
| A07, A10 | Clinical instructions where a translation error is a safety error, not a style one — the strongest material for the subjective quality section |
| B02, B03, B05 | Product and company names (*Interpreter Intelligence*, *VoiceBoxer*, *AI Pro*) that translation may wrongly translate rather than leave intact |

**Translation quality is judged subjectively**, per the brief. No reference
Spanish is provided here: an unverified reference translation would invite
false precision on top of a scoring method the brief did not ask for. Spot-check
the target lane on the hazard rows above and record impressions while the audio
is fresh.
