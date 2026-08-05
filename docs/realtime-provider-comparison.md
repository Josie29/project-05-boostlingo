# Realtime speech provider comparison

Landscape scan of streaming speech providers, focused on the two things that
actually differ between them: **how they decide an utterance ended**, and **what
they hand you when it does**. Verified against vendor documentation, August 2026.

Two distinct product categories are compared, because they solve this project's
problem in different shapes:

- **Voice-to-voice** — audio in, audio out, one model. What realtime mode uses.
- **Streaming STT** — audio in, text out. What cascade mode's first stage uses.

## Overview

| Provider | Category | Transport | Endpointing |
| --- | --- | --- | --- |
| **OpenAI Realtime** (`gpt-realtime`) | Voice-to-voice + STT-only mode | WebRTC, WebSocket, SIP | Acoustic **or** semantic |
| **Google Gemini Live** | Voice-to-voice | WebSocket | Acoustic, tunable sensitivity |
| **Amazon Nova 2 Sonic** | Voice-to-voice | Bidirectional stream (Bedrock) | Acoustic |
| **Deepgram** (Nova-3) | Streaming STT | WebSocket | Acoustic only |
| **AssemblyAI** (Universal-Streaming) | Streaming STT | WebSocket | Semantic |
| **Speechmatics** | Streaming STT **+ translation** | WebSocket | Acoustic, plus manual force |
| **Soniox** | Streaming STT **+ translation** | WebSocket | Acoustic, plus manual force |

## Endpointing — the interesting axis

**Acoustic** endpointing hears silence. **Semantic** endpointing judges whether
the *thought* is complete, so a speaker trailing off with "ummm…" gets a longer
grace period than a definitive statement. Only two providers here do the latter.

| Provider | Mode | Tunables | Notes |
| --- | --- | --- | --- |
| **OpenAI** | `server_vad` | `prefix_padding_ms` (300), `silence_duration_ms` (500) | Pure volume-based |
| **OpenAI** | `semantic_vad` | `eagerness`: `low`/`medium`/`high`/`auto` → max timeout 8s / 4s / 2s | Classifier scores probability the speaker is done. Padding/silence params do **not** apply |
| **AssemblyAI** | Semantic | `end_of_turn_confidence_threshold` (0.7), `min_end_of_turn_silence_when_confident` (160ms), `max_turn_silence` | Model predicts an end-of-turn token. Setting threshold to `0` disables semantics and reverts to pure silence |
| **Gemini Live** | Acoustic, tunable | `start_of_speech_sensitivity`, `end_of_speech_sensitivity`, `prefix_padding_ms`, `silence_duration_ms` | Can be disabled entirely; client then sends `ActivityStart` / `ActivityEnd` |
| **Deepgram** | Acoustic | `endpointing` (default 10ms), `utterance_end_ms` | Docs are explicit that this is silence detection, not sentence boundaries |
| **Speechmatics** | Acoustic | `end_of_utterance_silence_trigger` (0–2s) | Plus `ForceEndOfUtterance` client message |
| **Soniox** | Acoustic | endpoint detection | Plus a `finalize` message to force pending tokens final |
| **Nova 2 Sonic** | Acoustic | not exposed in docs | VAD detects boundaries and barge-in |

## Event vocabulary — same concepts, different names

Every provider expresses the same five ideas. Only the strings differ, which is
exactly why `ISttProvider` is worth having.

| Concept | OpenAI | Deepgram | AssemblyAI | Speechmatics | Soniox |
| --- | --- | --- | --- | --- | --- |
| Session opened | `session.created` | — | `Begin` | `RecognitionStarted` | — |
| Speech started | `input_audio_buffer.speech_started` | `SpeechStarted` | — | — | — |
| Partial / revisable | `...transcription.delta` | `is_final: false` | `Turn` (`end_of_turn: false`) | `AddPartialTranscript` | token `is_final: false` |
| Final / settled | `...transcription.completed` | `speech_final: true` | `Turn` (`end_of_turn: true`) | `AddTranscript` | token `is_final: true` |
| Turn committed | `input_audio_buffer.committed` | `UtteranceEnd` | `end_of_turn` + `end_of_turn_confidence` | `EndOfUtterance` | endpoint detection |
| Session ended | — | — | `Termination` | `EndOfTranscript` | — |

Note the granularity difference: OpenAI, Deepgram, AssemblyAI, and Speechmatics
emit **segment-level** results; Soniox emits **token-level** results, each token
independently carrying `is_final`, `speaker`, `language`, and
`translation_status`.

## Other attributes worth tracking

| Provider | Standout |
| --- | --- |
| **OpenAI** | Only provider offering WebRTC *and* SIP alongside WebSocket — SIP means telephony without a media gateway. Also the only one exposing a transcription-only mode of a voice-to-voice model (`?intent=transcription`) |
| **Gemini Live** | **Session resumption** — tokens valid 2h after disconnect, so a dropped connection keeps its context. **Context window compression** via server-side sliding window, addressing the cost-grows-with-session problem directly (native audio accrues ~25 tokens/second) |
| **Nova 2 Sonic** | Event-driven bidirectional stream on Bedrock; barge-in sends an explicit interruption notification rather than leaving the client to infer it. Relevant if deployment lands on AWS |
| **Deepgram** | Cheapest streaming tier, and the only one whose docs state plainly that endpointing is acoustic. `vad_events` splits speech-detection signals from transcript results |
| **AssemblyAI** | Semantic turn detection with a **confidence score exposed per turn**, so the app can apply its own threshold. Billed on **WebSocket connection duration, not audio sent** — an idle open socket still costs |
| **Speechmatics** | **Translation inside the transcription stream** (`AddPartialTranslation` / `AddTranslation`). Also speaker diarization with `prefer_current_speaker`, and `AudioEventStarted` for non-speech sounds |
| **Soniox** | **Two-way realtime translation** in-stream, **per-token language identification** supporting code-switching mid-sentence, 60+ languages freely mixed. Manual `finalize` gives the application control over segmentation |

## Relevance to this project

**Three of these collapse a cascade stage.** Speechmatics and Soniox return
translated text from the same socket that returns the transcript, removing the
separate MT stage — and with it a network hop and a queue. That trades away
per-stage provider choice, which is the cascade's whole argument, so it is a
genuine architectural fork rather than a free win.

**Soniox's per-token language ID is the most interesting capability here for an
interpretation product.** Every provider in this project's current design fixes
one source language per session (`SttStreamConfig.SourceLang`). Soniox detects
language per token and handles code-switching mid-sentence — which is what
actually happens when a bilingual speaker talks. It maps onto Boostlingo's
275-language network far better than a fixed-pair design does.

**Semantic endpointing is rarer than expected.** Among dedicated STT vendors
only AssemblyAI offers it. This project already uses `semantic_vad`
(`OpenAiSttProvider.VadType`), so a swap to Deepgram or Speechmatics would be a
downgrade on turn detection even where it is an upgrade on price — worth stating
in any provider-swap recommendation.

**Barge-in is not portable.** Voice-to-voice providers handle interruption
internally; STT providers hand you a speech-started signal and you build the
rest, as this project does (#11). Swapping STT vendors means re-deriving that
signal from a different event.

## Sources

- [OpenAI — Realtime API guide](https://developers.openai.com/api/docs/guides/realtime)
- [OpenAI — Voice activity detection](https://developers.openai.com/api/docs/guides/realtime-vad)
- [OpenAI — Realtime client events reference](https://developers.openai.com/api/reference/resources/realtime/client-events)
- [Google — Gemini Live API](https://ai.google.dev/gemini-api/docs/live)
- [Google — Live API WebSockets reference](https://ai.google.dev/api/live)
- [Google — Session management with Live API](https://ai.google.dev/gemini-api/docs/live-session)
- [AWS — Using the Amazon Nova Sonic speech-to-speech model](https://docs.aws.amazon.com/nova/latest/userguide/speech.html)
- [AWS — Handling output events with the bidirectional API](https://docs.aws.amazon.com/nova/latest/userguide/output-events.html)
- [Deepgram — Endpointing](https://developers.deepgram.com/docs/endpointing)
- [AssemblyAI — Turn detection](https://www.assemblyai.com/docs/streaming/universal-streaming/turn-detection)
- [AssemblyAI — Universal-Streaming](https://www.assemblyai.com/docs/speech-to-text/universal-streaming)
- [AssemblyAI — Intelligent turn detection (blog)](https://www.assemblyai.com/blog/turn-detection-endpointing-voice-agent)
- [Speechmatics — Realtime API reference](https://docs.speechmatics.com/rt-api-ref)
- [Soniox — Real-time transcription](https://soniox.com/docs/stt/rt/real-time-transcription)
