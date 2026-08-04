# Tech Stack — AI Interpreter Workbench (Boostlingo)

| Layer | Component | Choice | Reason |
|---|---|---|---|
| Backend | Language / runtime | C# / .NET 10 (ASP.NET Core) | Partner-preferred stack; strong async + WebSocket support for streaming audio |
| Backend | Client transport (cascade) | Raw WebSockets | Bi-directional binary audio streaming with no framework abstraction in the hot path |
| Backend | Realtime-mode transport | Browser ↔ OpenAI via WebRTC, backend mints ephemeral tokens | Lowest latency path; OpenAI-recommended pattern; keeps API key server-side |
| Backend | Provider abstraction | C# interfaces (`ISttProvider`, `ITranslationProvider`, `ITtsProvider`) | Brief requires swappable providers; interfaces are the idiomatic C# contract |
| Cascade | STT (Speech to Text) | OpenAI `gpt-4o-transcribe` (streaming WS) | Streaming partials on the single OpenAI key; fastest start |
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
- Whether per-stage latency metrics live purely client-side or get a backend aggregation endpoint — resolve when building the instrumentation UI.
