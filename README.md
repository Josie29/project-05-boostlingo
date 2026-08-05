# boostlingo

Hiring partner project — Gauntlet AI. AI Interpreter Workbench: two live-interpretation
architectures built side by side and instrumented against each other.

- **Realtime mode** — OpenAI Realtime API (`gpt-realtime`), voice in / voice out.
- **Cascade mode** — composed STT → Translation → TTS pipeline, streaming end to end,
  providers swappable behind interfaces.

The deliverable is not just a working demo: it is a defensible opinion on which
architecture fits which scenario, backed by per-stage latency instrumentation visible
in the UI.

- [docs/BRIEF.md](docs/BRIEF.md) — the partner brief, verbatim
- [docs/tech-stack.md](docs/tech-stack.md) — stack decisions, chosen vs. rejected
- [docs/comparison.md](docs/comparison.md) — the Realtime vs. Cascade comparison write-up
- [docs/claude-usage.md](docs/claude-usage.md) — how the coding agent was directed (required by the brief)
- [CLAUDE.md](CLAUDE.md) — operational context loaded by agent sessions

## Acronyms

| Term | Stands for | What it means here |
| --- | --- | --- |
| STT | Speech to Text | Transcribes microphone audio into source-language text. Also called ASR (Automatic Speech Recognition). First stage of the cascade. |
| TTS | Text to Speech | Synthesizes the translated text back into audible speech. Last stage of the cascade. |
| MT | Machine Translation | Source-language text to target-language text. Middle stage of the cascade. |
| SPA | Single Page Application | The browser client — one page, no full reloads, holds the live audio session. |
| WER | Word Error Rate | Standard accuracy metric for STT output: percentage of words inserted, deleted, or substituted vs. a reference transcript. Lower is better. |
| PCM | Pulse Code Modulation | Raw uncompressed audio samples — the format streamed from the mic to the STT provider. |
| VAD | Voice Activity Detection | Decides when speech starts and stops, which is what triggers the pipeline to commit a segment. |
| RTC | Real-Time Communication | WebRTC is the peer-to-peer protocol Realtime mode uses for direct browser↔OpenAI audio. |
| Barge-in | (not an acronym) | The speaker starting a new utterance while output audio is still playing, requiring the playback queue to flush. |

## Status

Feature-complete. Both modes (Realtime and Cascade) are wired end to end, with
language pair selection, per-stage latency instrumentation, barge-in handling,
error hardening, and a config-swappable second MT provider.

## Architecture

Two interpretation architectures share one mode-agnostic UI.

### Realtime mode

```
Mic ──WebRTC──▶ OpenAI Realtime API (gpt-realtime) ──WebRTC──▶ Speaker
                        │
                        └─ transcription events ──▶ data channel ──▶ transcript/latency panels
```

The browser talks to OpenAI directly over WebRTC. The backend's only realtime
job is minting a short-lived client secret (`POST /api/realtime/session`, see
`backend/RealtimeSession.cs`) so the `OPENAI_API_KEY` never reaches the
browser. `frontend/src/realtime/RealtimeSessionController.ts` owns the peer
connection, mic tracks, and the `oai-events` data channel.

### Cascade mode

```
Mic ─PCM16─▶ /ws/cascade ─▶ STT (ISttProvider) ─segments─▶ MT (ITranslationProvider)
 (browser)   (WebSocket)         │                              │ tokens
                                 ▼                              ▼
                        transcript.partial/final      SentenceChunker ─phrases─▶ TTS (ITtsProvider)
                             (source lane)                 (target lane)              │
                                                                                     ▼
Browser ◀── tts.audio.start / binary PCM frames / tts.audio.end ◀────────────────────┘
```

The browser streams 24 kHz PCM16 over a WebSocket (`backend/CascadeSession.cs`
is the transport; the JSON envelope and payload types live in
`backend/CascadeProtocol.cs`). `backend/CascadePipeline.cs` orchestrates the
stages: STT segments stream to the client as source-lane transcripts and queue
for translation; translation tokens stream to the target lane while
`backend/SentenceChunker.cs` cuts them into phrases; `backend/TtsCascadeObserver.cs`
synthesizes each phrase and pushes raw PCM frames the browser's
`AudioPlaybackQueue` schedules gaplessly. Every stage streams — nothing waits
for a full utterance. Barge-in (speech re-starting mid-playback) cancels
in-flight translation/synthesis and flushes client playback.

### The provider seam

Cascade stages hide behind three interfaces — `ISttProvider`,
`ITranslationProvider`, `ITtsProvider` (`backend/Providers/`). Everything
vendor-specific (endpoints, wire shapes, model names) lives inside one provider
class, so swapping a vendor is a contained change. This is demonstrated, not
just claimed: the MT stage ships with two implementations — OpenAI
(`gpt-4o-mini`) and Anthropic Claude (`claude-haiku-4-5`) — selected by
`TRANSLATION_PROVIDER=openai|anthropic` with no code changes outside the
provider class and its registration.

### Frontend seam

`frontend/src/session/InterpreterSession.ts` is the mode-agnostic interface
both transports implement. Shared UI (transcript panel, latency panel, session
controls) consumes only that seam; wire-format knowledge stays in the
`realtime/` and `cascade/` adapter directories. Transcript and latency history
live above both transports, which is what makes mid-session mode switching
preserve them.

## Setup

### Prerequisites

- [.NET 10 SDK](https://dotnet.microsoft.com/download)
- [Node.js](https://nodejs.org/) 20+
- An OpenAI API key with access to the Realtime API (`gpt-realtime`) and
  standard chat/audio endpoints — both modes and the full cascade
  (STT/MT/TTS) run on this one key.

### Backend

```bash
cd backend
cp ../.env.example ../.env   # fill in OPENAI_API_KEY
dotnet run
```

Optional: to run the cascade's translation stage on Anthropic Claude instead
of OpenAI, also set `TRANSLATION_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`
in `.env` (see `.env.example` for the model-override knob).

Serves on `http://localhost:5170`. Confirm it's up:

```bash
curl http://localhost:5170/healthz
```

### Frontend

In a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Serves on `http://localhost:5173` and proxies `/api`, `/healthz`, and `/ws`
to the backend (see `frontend/vite.config.ts`) — no CORS setup or hardcoded
base URL needed. Open `http://localhost:5173` with the backend already
running.

### Trying it out

1. Pick a language pair (English ↔ Spanish is the tested minimum).
2. Choose **Realtime** or **Cascade** mode.
3. Start the session, grant microphone permission, and speak.
4. Watch the live source/target transcript and the per-stage latency panel
   as you go; switch modes between sessions to compare them.

### Tests

```bash
# Backend
cd backend
dotnet test

# Frontend
cd frontend
npm test
```
