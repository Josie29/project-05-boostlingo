# Tech Stack — AI Interpreter Workbench (Boostlingo)

| Layer | Component | Choice | Reason |
|---|---|---|---|
| Backend | Language / runtime | C# / .NET 10 (ASP.NET Core) | Partner-preferred stack; strong async + WebSocket support for streaming audio |
| Backend | Client transport (cascade) | Raw WebSockets | Bi-directional binary audio streaming with no framework abstraction in the hot path |
| Backend | Realtime-mode transport | Browser ↔ OpenAI via WebRTC, backend mints ephemeral tokens | Lowest latency path; OpenAI-recommended pattern; keeps API key server-side |
| Backend | Provider abstraction | C# interfaces (`ISttProvider`, `ITranslationProvider`, `ITtsProvider`) | Brief requires swappable providers; interfaces are the idiomatic C# contract |
| Cascade | STT (Speech to Text) | OpenAI `gpt-4o-mini-transcribe` (streaming WS) | Streaming partials on the single OpenAI key; fastest start |
| Cascade | MT (Machine Translation) | OpenAI `gpt-4o-mini` (streaming chat) | Streams token-by-token so TTS can start early; cheap; same key |
| Cascade | TTS (Text to Speech) | OpenAI `gpt-4o-mini-tts` (streaming) | Streamed audio chunks; same key; adequate voice quality for the demo |
| Frontend | Language / framework | TypeScript + React 19 | Partner-preferred frontend language; React state fits live transcripts + mode toggle |
| Frontend | Build tooling | Vite | Brief demands an SPA, not SSR; fastest dev loop |
| Frontend | Package manager | npm | Default, zero extra tooling; no workspace/monorepo needs |
| Testing | Backend | xUnit | .NET default; targeted tests on pipeline + provider boundaries per brief |
| Testing | Frontend | Vitest | Native Vite integration; minimal frontend test surface anyway |
| Infra | Deployment | Local-only, documented setup | Deployment optional per brief; 15–20h budget better spent on latency work |
| Infra | CI | None (git history only) | Not required by brief; time-boxed build |

## Rejected alternatives

| Component | Option | Why not |
|---|---|---|
| Backend language | TypeScript/Node end-to-end | Faster to build, but forfeits the partner's stated .NET/C# preference |
| Backend language | Python (FastAPI) | Acceptable per brief but async binary audio streaming is fiddlier than .NET |
| Client transport (cascade) | SignalR | Hub abstraction + MessagePack overhead adds nothing for a single binary audio stream |
| Client transport (cascade) | HTTP chunked/SSE | Not bi-directional; mic upstream would need a second channel |
| Realtime-mode transport | Backend WebSocket relay to OpenAI | Extra hop adds latency against the 1.5s budget; WebRTC handles jitter natively |
| STT | Deepgram | Best-in-class streaming STT, but second account/key; deferred to the swap demo |
| STT | `whisper-1` REST | Full-utterance blocking — brief explicitly forbids non-streaming cascade |
| MT | Anthropic Claude | Comparable quality, second key; kept as the natural provider-swap candidate |
| MT | DeepL | Strong MT but no token streaming, so TTS can't start early |
| TTS | ElevenLabs | Best voice quality, but second account and higher cost per minute |
| TTS | Azure Speech / Polly | Extra cloud account for no streaming advantage over OpenAI TTS |
| Frontend framework | Next.js | SSR/routing machinery unused in a single-page audio client |
| Frontend package manager | pnpm | No monorepo or disk-space pressure to justify the extra tool |
| Deployment | AWS (partner-preferred if deploying) | Optional per brief; costs hours the latency instrumentation needs |

## Open sub-decisions

- Second provider per cascade stage (Deepgram STT, Claude MT, or ElevenLabs TTS) to prove the abstraction with a real swap — decide near end of build if time allows; interfaces designed for it from day one.
- **Resolved (STT stage, #5):** VAD (Voice Activity Detection) strategy for the cascade — chose OpenAI server-side VAD in **`semantic_vad`** mode over `server_vad` and over client-side segmentation. `server_vad`'s fixed silence-duration threshold forces a tradeoff that doesn't fit a cascade: a short threshold clips speakers mid-thought (garbling the utterance MT/TTS receive next), while a long enough threshold to avoid that adds fixed latency to *every* utterance regardless of how it was actually spoken. `semantic_vad` instead uses a semantic-completion classifier to end the turn when the utterance itself sounds finished, which gives cleaner utterance boundaries for downstream MT with no per-utterance threshold tuning — worth the small extra inference cost given the cascade's OpenAI round trips already dominate end-to-end latency. Client-side segmentation was rejected outright: it would duplicate VAD logic OpenAI already runs server-side for free as part of the same connection. Caveat: this was decided without a live OPENAI_API_KEY in the dev environment, so `semantic_vad` support for the *transcription* intent specifically (as opposed to full realtime conversation sessions) should be spot-checked against current OpenAI docs the first time this runs against a real key; the VAD mode is a single constant (`OpenAiSttProvider.VadType`) if it needs to fall back to `server_vad`.
- **Resolved (#10, per-stage latency instrumentation):** metrics live purely client-side — no backend aggregation endpoint. The client already receives every timing signal it needs on the existing cascade WebSocket (see below); a backend endpoint would only add a second thing to keep in sync with zero benefit, since nothing here needs to survive a page reload or be compared across sessions server-side. Two things had to be settled together to make that work without clock-offset math between browser and server:
  - **Every outbound cascade envelope carries `serverTimeMs`** (`CascadeOutboundEnvelope.ServerTimeMs`, `DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()`), and a dedicated `latency.mark` envelope type (`CascadeMessageTypes.LatencyMark`, payload `CascadeLatencyMarkPayload { utteranceId, stage, serverTimeMs }`) is emitted at seven boundaries per utterance: `speechEnd` (STT provider's VAD (Voice Activity Detection) committed the turn — see `SttSegment.IsSpeechEndMarker`/`SttSegment.SpeechEnd`), `sttFirstPartial`, `sttFinal`, `mtFirstToken`, `mtFinal`, `ttsFirstByte` (first synthesized audio chunk from the TTS provider), `ttsEnd`. All seven marks for one spoken utterance share one `utteranceId` — the source-lane id, not the derived `"-target"` id MT/TTS use for transcript bookkeeping.
  - **Clock discipline: server-relative timestamps only.** Every server-side stage-to-stage duration the client computes must be a difference of two `serverTimeMs` values (both produced by the same server clock), never a client-timestamp-minus-server-timestamp subtraction — that would require assuming a client/server clock offset the app has no way to measure. The two boundaries that are genuinely client-side (raw mic capture start, first audio actually audible after browser-side buffering/AudioContext scheduling) are timed with the client's own `performance.now()`/equivalent and reported as durations, not absolute-clock-compared-to-server timestamps. A full perceived end-to-end latency (speech end → audio audible) is the sum of a server-relative span (`speechEnd` → `ttsEnd`, all server clock) plus a client-only span (client receipt of the first TTS audio frame → that frame's audible playback) — two same-clock differences added together, never a cross-clock one.
  - Cascade only: realtime mode is a direct browser↔OpenAI WebRTC connection (see the transport row above) the backend has no visibility into, so its latency instrumentation (end-to-end perceived latency plus whatever event timings the Realtime API itself exposes) is necessarily fully client-side regardless of this decision.
  - **Amended (local persistence):** the "nothing needs to survive a page reload or be compared across sessions" premise stopped holding once `docs/benchmarks.md` needed real cross-session numbers, so a persistence layer was added: the frontend posts each conversation's accumulated latency reports and transcript to `POST /api/metrics/conversations` at session stop, stored in local SQLite behind `ISessionMetricsStore` (`backend/Persistence/`), with `GET /api/metrics/summary` computing the per-(mode, MT provider) median/p95 figures the benchmark tables are phrased in. Everything else above stands unchanged — *measurement* is still fully client-side with the same clock discipline (the client remains the only place both modes' timings exist, so it is also the reporter); only the finished numbers now get written down. SQLite over Postgres/EF Core: single-file, zero services, and the store interface is the swap seam a cloud deployment would use (see `docs/deployment-plan.md`).
