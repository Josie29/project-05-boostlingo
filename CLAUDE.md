# CLAUDE.md

Real-time speech interpreter with two modes: **Realtime** (browser ↔ OpenAI
directly over WebRTC; the backend only mints ephemeral client secrets) and
**Cascade** (mic PCM over WebSocket to the backend, then STT → MT → TTS through
provider interfaces). ASP.NET Core (.NET 10) backend, React 19 + Vite frontend.

The brief-required narrative of *how* the agent was directed on this project
lives in `docs/claude-usage.md` — that file is for human reviewers; this one
is operational context for agent sessions.

## Commands

- Backend: `dotnet test` and `dotnet run` from `backend/` (listens on
  `localhost:5170`; `dotnet watch` for hot reload).
- Frontend: `npx vitest run`, `npx tsc -b`, and `npm run dev` from `frontend/`
  (Vite proxies `/api`, `/healthz`, and `/ws` to 5170).
- **Both suites must be green before any commit.** Both run offline — no API
  keys needed. Vitest does not typecheck; run `tsc -b` too when TS changed.
- Live sessions need `OPENAI_API_KEY` in the repo-root `.env` (DotNetEnv loads
  it; shell env vars win) or `dotnet user-secrets`. Optional:
  `TRANSLATION_PROVIDER=openai|anthropic` (+ `ANTHROPIC_API_KEY`),
  `METRICS_DB_PATH` (defaults to `backend/data/metrics.db`, gitignored).

## Where things live

- `backend/Program.cs` — all DI wiring; provider selection fails startup on an
  unrecognized `TRANSLATION_PROVIDER` rather than falling back.
- `backend/CascadeProtocol.cs` — the cascade wire protocol: envelope, message
  types, latency marks, error taxonomy. Read this first for anything cascade.
- `backend/CascadeSession.cs` — WebSocket transport (`/ws/cascade`);
  `backend/CascadePipeline.cs` — STT/MT orchestration and barge-in;
  `backend/TtsCascadeObserver.cs` — translation-to-TTS glue.
- `backend/Providers/` — **the load-bearing boundary**: everything
  vendor-specific stays in one provider file; the pipeline talks only to
  `ISttProvider`/`ITranslationProvider`/`ITtsProvider`.
- `backend/Languages.cs` — the single language registry; adding a language is
  exactly one entry, nothing else changes.
- `backend/Persistence/` + `backend/MetricsEndpoints.cs` — SQLite session
  metrics behind `ISessionMetricsStore`; the frontend posts each conversation
  at Stop, `GET /api/metrics/summary` serves the benchmark numbers.
- `frontend/src/session/InterpreterSession.ts` — the mode-agnostic seam both
  transports implement; `frontend/src/api.ts` — the sole fetch seam.
  `latency/` and `transcript/` are transport-agnostic domains fed by per-mode
  adapters; shared UI never imports a concrete transport.

## Invariants that bite

- **Id spaces:** every per-utterance event (marks, errors) keys on the
  source-lane utterance id; MT/TTS transcript bookkeeping uses a derived
  `"-target"` id; the frontend namespaces all ids per mode
  (`cascade:`/`realtime:` — `prefixId` in `InterpreterSession.ts`).
- **Clock discipline:** every latency span is a difference of two
  `serverTimeMs` values or two client-side times — never client-minus-server.
- **Audio format:** PCM16 mono 24 kHz both directions (OpenAI's transcription
  intent rejects lower rates — verified against a live key, not docs).
- `transcript.partial` carries **deltas**; `transcript.final` carries the
  **full settled text** (appending it would double the text).
- Telemetry never kills the pipeline: latency-mark and error-event send
  failures are logged at Debug and swallowed (`CascadeLatencyMarks`,
  `CascadeErrors`) — keep that property when adding instrumentation.
- The backend has **no visibility into Realtime mode's traffic** — anything
  needing both modes' timings must be captured client-side.

## Conventions

- Do not overcomment the code, only comment what is truly helpful for readability.
- Enums over bool flags and string literals for fixed option sets.
- Tests: `backend/tests/` and `frontend/src/__tests__/`; every non-trivial
  test's comment names the user-facing behavior that breaks if it's removed;
  assert behavior, not implementation.
- Scoped commits describing all staged changes; no AI attribution anywhere;
  squash-merge PRs.
- Implement directly in the main session — project implementor sub-agents were
  tried and removed as net-negative (`docs/claude-usage.md`); read-only review
  fan-outs are still fine.
- `docs/tech-stack.md` records resolved decisions — when a change revises one
  (as persistence did to "metrics live purely client-side"), amend the entry
  with the new rationale instead of silently contradicting it.

## Docs

`docs/BRIEF.md` (requirements) · `docs/tech-stack.md` (decisions + resolved
sub-decisions) · `docs/benchmarks.md` (method; results pending a live run) ·
`docs/comparison.md` (mode comparison write-up) · `docs/deployment-plan.md`
(functionality → AWS mapping) · `docs/claude-usage.md` (agent-usage narrative).
