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

## Register, and what it costs

Every line is company briefing content: a spoken corporate presentation being
interpreted. That is a genuine Boostlingo product surface — remote simultaneous
interpretation (RSI) and AI Pro live captioning both target conferences,
corporate training, and all-hands meetings.

The tradeoff is real and worth stating in the write-up: this register does
**not** exercise clinical dialogue, which is Boostlingo's largest vertical and
the setting where a translation error is a safety error rather than a style
one. Presentation speech is also cleaner than live interpretation work —
no overlapping speakers, no disfluencies, no background noise. Treat the
resulting numbers as a controlled floor, not a field measurement.

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

## Section A — company, people, and history

| ID | Utterance | Words |
| --- | --- | --- |
| A01 | Boostlingo was founded in twenty sixteen. | 6 |
| A02 | The company is headquartered in Austin, Texas. | 7 |
| A03 | Bryan Forrester is the chief executive officer. | 7 |
| A04 | Matt Cotton serves as chief technology officer. | 7 |
| A05 | Their mission is communication without barriers. | 6 |
| A06 | Three co-founders still lead the business. | 6 |
| A07 | They acquired two companies in twenty twenty-two. | 7 |
| A08 | The company started in San Francisco and relocated its headquarters to Austin, Texas in twenty twenty-one, where it now operates from an office on San Jacinto Boulevard. | 27 |
| A09 | Its three co-founders are Bryan Forrester, who serves as chief executive, Brian D'Agostino, the chief product officer, and Dieter Runge, who leads global strategy and business development. | 27 |
| A10 | In twenty twenty-two the company acquired Interpreter Intelligence, which built interpretation management and booking software, and VoiceBoxer, which built remote simultaneous interpreting technology for live events. | 26 |
| A11 | Both acquired founders stayed with the company: Conor Power became vice president of engineering, and Sergio Llorian became president of the Europe, Middle East, and Africa region. | 27 |
| A12 | Their stated mission is to build technology that empowers customers and the people they serve to communicate without barriers, and to increase language access for everyone. | 26 |
| A13 | The company has been named to Inc. Magazine's Best Workplaces list for four consecutive years through twenty twenty-six. | 18 |
| A14 | Its AI advisory board includes Nick Olsen, Stevan Relic, Barnaby Dorfman, and the natural language researcher Anders Søgaard. | 18 |

## Section B — products, scale, and AI direction

| ID | Utterance | Words |
| --- | --- | --- |
| B01 | They published an AI accuracy study. | 6 |
| B02 | AI Pro reports ninety to ninety-eight percent accuracy. | 8 |
| B03 | Human interpreters answer in about five seconds. | 7 |
| B04 | Boostlingo connects organizations with more than ten thousand qualified interpreters across two hundred seventy-five languages, available around the clock through phone, video, and on-site appointments. | 25 |
| B05 | In twenty twenty-six they released their AI Interpreter to general availability with a quality evaluation system, after reporting that three in four healthcare leaders would use AI when interpreter waits reach five minutes. | 33 |
| B06 | Their AI Pro product covers over one hundred thirty languages and four thousand six hundred forty-four language combinations. | 18 |

## Composition

| Class | Count | IDs |
| --- | --- | --- |
| Short (≤ 8 words) | 10 | A01–A07, B01–B03 |
| Long (≥ 20 words) | 7 | A08–A12, B04, B05 |
| Numeric / proper-noun heavy | 3 | A13, A14, B06 |

Short utterances expose fixed per-utterance overhead — connection turnaround,
VAD commit delay, time-to-first-token — because there is almost no audio to
decode. Long utterances expose throughput and streaming behavior: whether MT
starts emitting before STT finalizes, and whether TTS starts before MT
completes. Both classes are needed; reporting only one hides half the story.

## Scoring notes

**Normalize before computing WER.** Spoken numbers come back as digits from
some models and as words from others: B06 may transcribe as "4,644" against a
reference reading "four thousand six hundred forty-four". Scored raw, that is
five word errors caused by formatting rather than recognition. Normalize both
sides — lowercase, strip punctuation, expand or collapse numerals consistently
— before aligning.

**Lines expected to break first.** Worth watching individually rather than only
in the aggregate:

| ID | Hazard |
| --- | --- |
| A14 | The hardest line in the set: four unfamiliar personal names, one of them non-ASCII (*Søgaard*). If any line exposes a difference between STT tiers, this is it. |
| A09, A11 | Personal names across several language origins — *D'Agostino*, *Runge*, *Llorian*, *Conor Power* — plus an apostrophe and a regional acronym expansion |
| A08 | Place names in two languages inside one English sentence (*San Francisco*, *San Jacinto*), where an English-configured STT stream is least confident |
| B06, A13 | Large spoken numerals and a year — the normalization case above |
| A10, B04, B05 | Product and company names (*Interpreter Intelligence*, *VoiceBoxer*, *AI Pro*, *AI Interpreter*) that translation may wrongly render into Spanish rather than leave intact. Watch the target lane here specifically: a proper noun that gets translated is a visible product bug, not a subjective quality call. |
| A05 vs A12 | The same mission stated in six words and in twenty-six. Comparing their translations is a cheap read on whether the MT stage handles compression differently from elaboration. |

**Translation quality is judged subjectively**, per the brief. No reference
Spanish is provided here: an unverified reference translation would invite
false precision on top of a scoring method the brief did not ask for.
Spot-check the target lane on the hazard rows above and record impressions
while the audio is fresh.
