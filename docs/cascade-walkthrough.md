# Cascade walkthrough

What each stage accepts and returns, traced through one real utterance.

Figures come from `backend/data/metrics.db` (local dev capture, 6 sessions /
23 utterances) — indicative, not the final benchmark run. See
[benchmarks.md](benchmarks.md) for the formal method.

**Spine:** `cascade:item_E9aXoXWNgIVL6nkwYACDV`, 1,962 ms end-to-end — line A11
of [benchmark-script.md](benchmark-script.md).

## Stage 0 — Browser → backend

Raw PCM16, mono, **24 kHz** (`CascadeProtocol.SampleRateHz`), as binary
WebSocket frames. No encoding, no container.

## Stage 1 — STT (`gpt-4o-mini-transcribe`)

**Accepts** — WebSocket to `wss://api.openai.com/v1/realtime?intent=transcription`,
one `session.update` before any audio:

```json
{"type":"session.update","session":{"type":"transcription",
  "audio":{"input":{"format":{"type":"audio/pcm","rate":24000},
    "transcription":{"model":"gpt-4o-mini-transcribe","language":"en"},
    "turn_detection":{"type":"semantic_vad"}}}}}
```

then audio, base64 inside JSON (~33% wire inflation):

```json
{"type":"input_audio_buffer.append","audio":"UklGRiQA..."}
```

**Returns** — four events matter (`OpenAiSttProvider.ParseEventElement`):

| Event | Carries | Becomes |
| --- | --- | --- |
| `input_audio_buffer.speech_started` | — | `SpeechStart` → barge-in (#11) |
| `...transcription.delta` | `item_id`, `delta` | `Partial` |
| `input_audio_buffer.committed` | `item_id` | `SpeechEnd` → starts the latency clock |
| `...transcription.completed` | `item_id`, `transcript` | `Final` |

Actual: `"Connor Power became Vice President of Engineering and Sergio Lourian
became President of Europe, Middle East and Africa region."` (spoken: *Conor*,
*Llorian*).

## Stage 2 — MT (`gpt-4o-mini`)

Only **finals** reach this stage; partials are displayed but never translated.

**Accepts** — `POST /v1/chat/completions`:

```json
{"model":"gpt-4o-mini","stream":true,"messages":[
  {"role":"system","content":"You are a machine translation engine translating from en to es. Output only the translation itself... If the message is empty or has nothing translatable in it, output nothing."},
  {"role":"user","content":"Connor Power became Vice President of..."}]}
```

**Returns** — SSE, one token per frame, ending `data: [DONE]`:

```
data: {"choices":[{"delta":{"content":"Connor"}}]}
data: {"choices":[{"delta":{"content":" Power"}}]}
```

Actual: `"Connor Power se convirtió en Vicepresidente de Ingeniería y Sergio
Lourian se convirtió en Presidente de la región de Europa, Oriente Medio y
África."`

## Stage 3 — TTS (`gpt-4o-mini-tts`)

Tokens are buffered by `SentenceChunker`, which cuts on `. ! ? ; \n` —
deliberately not commas.

**Accepts** — `POST /v1/audio/speech`:

```json
{"model":"gpt-4o-mini-tts","input":"Connor Power se convirtió en...",
 "voice":"alloy","response_format":"pcm","stream_format":"audio"}
```

**Returns** — raw PCM16 24 kHz over a chunked HTTP body. No JSON, no framing.
Read in 4,096-byte slices, each one a `TtsAudioChunk`.

## Stage 4 — Backend → browser

`transcript.partial` / `transcript.final` per lane (target lane carries the
`-target` suffix), then `tts.audio.start` → binary PCM frames →
`tts.audio.end`, with `latency.mark` envelopes throughout.

## Reading the latency tables

`utterance_stages.ms` is a **delta from the nearest earlier stage**, not a
timestamp. `speechEnd` never appears in the table because it is the baseline
with nothing before it to diff against. Sort by `CASCADE_STAGE_ORDER`, not by
`ms`.

| Stage | Δ ms | Cumulative |
| --- | ---: | ---: |
| `speechEnd` | — | 0 |
| `sttFirstPartial` | 193 | 193 |
| `sttFinal` | 307 | 500 |
| `mtFirstToken` | 817 | 1,317 |
| `mtFinal` | 351 | 1,668 |
| `ttsFirstByte` | 290 | **1,958** |
| `ttsEnd` | 1,382 | 3,340 |

Recorded `end_to_end_ms` = 1,962.6 — the 1,958 ms server span plus ~4 ms
client receive-to-audible.

## Observed aggregates

| Mode | n | Mean | Min | Max |
| --- | ---: | ---: | ---: | ---: |
| realtime | 10 | 531 ms | 290 | 762 |
| cascade | 13 (10 timed) | 2,619 ms | 1,859 | 4,504 |

Mean per-stage delta, cascade:

| Stage | Mean Δ |
| --- | ---: |
| `sttFirstPartial` | 206 ms |
| `sttFinal` | 274 ms |
| `mtFirstToken` | **840 ms** |
| `mtFinal` | 300 ms |
| `ttsFirstByte` | **1,061 ms** |
| `ttsEnd` | 908 ms |

## Findings

**TTS first-byte dominates** (1,061 ms mean), MT time-to-first-token second
(840 ms). STT is comparatively cheap. Optimize the TTS dispatch first.

**The script may be hiding the streaming benefit.** `ttsFirstByte` never lands
before `mtFinal` in any captured row — consistent with every utterance being a
single sentence, so `SentenceChunker` finds only one boundary, at the end, and
synthesis cannot start early. On multi-sentence input TTS would begin at the
first period while MT was still translating. These cascade numbers are likely a
pessimistic read of the architecture, and that is a script-design artifact
rather than a pipeline limit.

**The empty-translation guard is visible in production data.**
`cascade:item_E9aYkDJsRNFEA0SDR0A6u` — source `"Stephen."`, target `""`. Its
stages stop at `mtFinal`: no `mtFirstToken`, no TTS marks. The MT stream closed
without emitting a content token (the "output nothing" instruction firing), so
`SentenceChunker` never saw a boundary and TTS was never called. `end_to_end_ms`
is `NULL` by design, not by failure.

**Script hazards resolved as predicted.** A14's unfamiliar names degraded worst
(*Stevan Relic* → `"Stephen."`, *Anders Søgaard* → `"Andrew Zolgard"`), and A11
mangled *Conor* → *Connor* and *Llorian* → *Lourian*. The product name
*Interpreter Intelligence* correctly survived translation untranslated.
