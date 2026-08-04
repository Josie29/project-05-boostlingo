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
| Barge-in | (not an acronym) | The speaker starting a new utterance while output audio is still playing, requiring the playback queue to flush. |

## Status

MVP-testable. Both modes (Realtime and Cascade) are wired end to end.

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
cp ../.env.example ../.env   # if you haven't already; fill in OPENAI_API_KEY
dotnet run
```

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
