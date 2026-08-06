# Realtime vs. Cascade: comparison and recommendation

Both architectures are implemented in this repo behind one mode-agnostic UI, with
per-stage latency instrumentation visible in the app. Numbers marked *estimate*
are derived from provider list pricing and architecture analysis; measured
figures land in [benchmarks.md](benchmarks.md) from the live benchmark session
(issue #14) and this document should be read alongside them.

## Latency

> **What "perceived latency" means here.** Every figure below and in
> benchmarks.md is measured from the instant the *browser observes* that speech
> ended — the arrival of cascade's `speechEnd` mark, or realtime's
> `speech_stopped` event — not from the instant the speaker stopped talking. A
> client-clock measurement can only start at something the client saw, and
> mixing in a server timestamp would break the clock discipline the whole
> instrumentation rests on. Microphone buffering, the upstream hops, and the
> VAD's deliberation therefore fall outside the number, so a speaker experiences
> a longer wait than these figures report — cascade by somewhat more than
> realtime, since its opening edge crosses two extra hops. See
> [benchmarks.md](benchmarks.md#known-residuals-stated-rather-than-corrected)
> for the full accounting. The comparison between modes stays sound; the
> absolute values are a floor, not the felt experience.

**Realtime** (voice→voice, one model): the model starts speaking as soon as its
VAD decides the turn ended. There are only two latency contributors — VAD
end-of-turn detection and model time-to-first-audio — and neither is
inspectable or independently tunable. Expected perceived latency (speech end →
first audio): **0.5–1.5 s**, comfortably inside the brief's 1.5 s target.

**Cascade** is a sum of stages, but streaming keeps it from being a sum of
*full* stages: translation starts on the finalized transcript while TTS starts
on the first translated *phrase* (sentence-chunked), not the full utterance.
The instrumented path is `speechEnd → sttFinal → mtFirstToken → ttsFirstByte →
playback`:

| Stage | Expected contribution (estimate) |
| --- | --- |
| VAD commit (semantic_vad) | 0.2–0.6 s |
| STT final transcript | 0.2–0.5 s |
| MT first token (gpt-4o-mini / claude-haiku-4-5) | 0.2–0.4 s |
| TTS first audio byte (first phrase) | 0.2–0.5 s |
| Network + playback scheduling | ~0.1 s |

Expected end-to-end: **~1.5–2.5 s** — inside the 3 s requirement, with the 2 s
streaming target reachable because MT→TTS overlap removes the longest serial
wait. The floor is structurally higher than realtime's: the cascade must wait
for a *final* transcript before translating, an ordering constraint realtime's
single model doesn't have.

## Quality

**Realtime** preserves prosody and tone (voice in, voice out) and can implicitly
repair ASR ambiguity inside one model. The costs: no intermediate artifacts to
audit, occasional interpreter-persona drift (answering instead of translating —
mitigated by instructions, never guaranteed), and quality is one indivisible
knob.

**Cascade** exposes text at every boundary, which makes quality *measurable*:
STT output can be scored as WER (Word Error Rate) against reference
transcripts — the standard `(insertions + deletions + substitutions) / words`
metric — and MT output can be evaluated or spot-audited independently of
synthesis. Errors compound across stages (an STT mistake is faithfully
translated), but each stage's contribution is visible in the transcript lanes,
so failures are diagnosable. Subjectively, cascade voices are flatter — TTS
reads translated text without the speaker's prosody.

## Cost per minute (estimates from list pricing)

Assumptions: one direction, roughly half the minute is speech; token↔audio
conversions per provider docs; validate against measured usage in benchmarks.md.

| | Realtime (`gpt-realtime`) | Cascade (STT→MT→TTS) |
| --- | --- | --- |
| Speech-to-text | — | gpt-4o-mini-transcribe ≈ $0.003/min |
| Translation | — | gpt-4o-mini or claude-haiku-4-5: <$0.001/min (short utterances) |
| Text-to-speech | — | gpt-4o-mini-tts ≈ $0.015/min of output audio |
| Voice-to-voice | audio in ≈ $0.02/min + audio out ≈ $0.04/min, plus growing cached-context input | — |
| **Ballpark total** | **$0.06–0.15/min** (rises with session length as context accumulates) | **$0.015–0.025/min** (flat per minute) |

Two structural points matter more than the exact figures: cascade cost is
**flat and per-stage tunable** (swap any stage for a cheaper vendor), while
realtime cost **grows within a session** because the model re-reads
accumulating conversation context.

## Controllability

This is the widest gap, and it was measured directly in this repo:

- **Provider swap surface**: adding the Anthropic Claude MT provider (#17)
  touched one new provider class and a one-line registration switch — nothing
  in the pipeline, protocol, or frontend. Realtime mode has no equivalent; the
  vendor is the architecture.
- **Failure isolation**: cascade failures are per-stage and per-utterance
  (typed provider exceptions → recoverable error envelopes, one-retry policy,
  mid-session STT reopen). One bad utterance degrades one utterance. A realtime
  failure is a dropped call (softened here by a reconnect grace period, but not
  isolatable below the session).
- **Prompt and model control**: each cascade stage has its own model choice,
  prompt, and latency/cost knob (e.g. `ANTHROPIC_MT_MODEL`). Realtime exposes
  instructions and a voice.

## Vendor lock-in and provider flexibility

Realtime couples the product to one vendor's proprietary protocol (WebRTC
signaling, event schema, pricing). The cascade's interfaces map onto commodity
markets with several credible vendors per stage (Deepgram/AssemblyAI/Soniox
for STT, Anthropic/DeepL for MT, ElevenLabs/Azure for TTS) — and the swap cost
is demonstrated, not hypothetical. This is also the **uncommon-language-pair
lever**: a cascade can pick the best STT and MT vendor *per language*, where
realtime quality is fixed at whatever the one model does for that pair.

## Time to onboard a language pair

Cascade: one entry in the `Languages.cs` registry (tag, display name, STT
language hint, TTS voice) — minutes of work, bounded by provider language
support, testable per stage. Realtime: the same registry entry feeds the
session instructions, but quality for the pair is untunable beyond prompting.

## Recommendation

- **Realtime** fits latency-critical, conversational, consumer-grade use on
  well-supported language pairs — casual calls where sub-second responsiveness
  and natural prosody outweigh auditability, and where per-minute cost at scale
  is acceptable.
- **Cascade** fits quality-critical and regulated interpretation (medical,
  legal, insurance — Boostlingo's core market): it produces auditable
  transcripts at every stage, isolates and reports failures per utterance,
  meets a 2–3 s latency budget with streaming, costs roughly 3–5× less per
  minute, and is the only architecture that can differentiate on uncommon
  language pairs via per-stage vendor choice.
- **Platform strategy**: build the cascade as the platform investment — the
  provider seam is where differentiated quality, cost control, and vendor
  leverage live — and offer realtime as a premium low-latency mode where its
  trade-offs (opacity, lock-in, session-scaling cost) are acceptable. The two
  share every mode-agnostic surface in this codebase already; that split is
  cheap to maintain.
