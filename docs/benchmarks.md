# Benchmarks — method and results

Raw material for [comparison.md](comparison.md), against the brief's targets:
Realtime < 1.5 s perceived end-to-end; Cascade < 3 s (target < 2 s with
streaming); a 5-minute back-and-forth session per mode with no disconnection,
audio drift, or unbounded memory growth.

> **Status: awaiting the live benchmark session.** Everything below the Method
> section is a template to fill from a session run with a real `OPENAI_API_KEY`
> (and optionally `TRANSLATION_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` for the
> provider-swap variant). All latency figures are captured automatically: every
> session's per-utterance latency reports and transcript are persisted to local
> SQLite when Stop is pressed, and `GET /api/metrics/summary` returns the
> median/p95 per stage, grouped per (mode, MT provider) — exactly the groupings
> the tables below use. The in-app latency panel remains the live view.

## Method

1. Start backend and frontend per the README; open the app in Chrome.
2. Per mode (Realtime, then Cascade), run a **5-minute** back-and-forth
   English↔Spanish conversation: alternate short utterances (3–8 words) and
   long ones (20+ words), include at least two deliberate barge-ins
   (cascade), and one mid-session mode switch at the end.
3. Press Stop at the end of each session — that is what persists the run.
   Then pull the figures: `curl -s localhost:5170/api/metrics/summary` gives
   median/p95 end-to-end and per-stage (speechEnd → sttFinal → mtFirstToken →
   ttsRequestSent → ttsFirstByte → ttsEnd) per (mode, MT provider);
   `/api/metrics/conversations` lists the captured sessions for sanity checks.
4. Stability: watch for WebSocket/WebRTC disconnects (none expected), audible
   drift or playback backlog growth in cascade, and memory growth — browser
   task manager for the tab, `dotnet-counters monitor` (or Activity Monitor
   RSS) for the backend, sampled at 0 / 2.5 / 5 minutes.
5. Cost: pull actual token/audio usage for the session window from the OpenAI
   (and Anthropic) usage dashboards; divide by session minutes.

## How the two modes are held comparable

The brief's number is *perceived* latency — speech end → first audio out — so
both modes measure the same window, on the same clock, opened by the same
event. Three things enforce that; changing any of them invalidates a
cross-mode comparison:

- **Same turn detection.** Both sessions request `semantic_vad`
  (`OpenAiSttProvider.VadType`, and `session.update` in
  `RealtimeSessionController`). Left to defaults the Realtime session would use
  a different VAD, and the two modes would disagree about when the speaker
  finished — the event the whole window hangs off.
- **Same opening edge.** The window opens where the speaker stopped talking.
  Cascade's provider only names the utterance at *commit*, later than the
  acoustic boundary, so the STT stream carries the `speech_stopped` instant
  forward and the `speechEnd` mark is backdated to it. The VAD's deliberation
  therefore sits inside the measurement, where the listener experiences it.
- **One clock per measurement.** Both modes' end-to-end is a client-clock
  subtraction: cascade from receiving the `speechEnd` mark to its first audio
  becoming audible; realtime from `input_audio_buffer.speech_stopped` to
  `output_audio_buffer.started`. Server-stamped marks still carry cascade's
  stage *breakdown* — they attribute the time, the client measures it. Stage
  medians therefore won't sum to the total; the remainder is wire time.

Known residual, stated rather than corrected: realtime's closing edge is when
the browser learns the server began sending audio, not when sound leaves the
speaker, because per-turn audibility isn't observable over WebRTC. Cascade's
closing edge *is* audibility (Web Audio schedules it). Realtime is therefore
understated by its jitter-buffer playout — tens of ms against a target of
1500 ms, and in the direction that flatters realtime.

## Results — Realtime

The breakdown splits into `responseCreated` and `audioStart`.

| Metric | Target | Measured |
| --- | --- | --- |
| Perceived latency, median (speech end → first audio) | < 1.5 s | _pending_ |
| Perceived latency, p95 | — | _pending_ |
| 5-min session: disconnects | 0 | _pending_ |
| 5-min session: memory growth (tab / backend) | bounded | _pending_ |
| Cost per minute (measured usage) | — | _pending_ |

## Results — Cascade (OpenAI providers)

| Metric | Target | Measured |
| --- | --- | --- |
| Perceived latency, median (speech end → first audio audible) | < 3 s (target < 2 s) | _pending_ |
| End-to-end, p95 | — | _pending_ |
| speechEnd → sttFinal, median | — | _pending_ |
| sttFinal → mtFirstToken, median | — | _pending_ |
| mtFirstToken → ttsRequestSent, median | — | _pending_ |
| ttsRequestSent → ttsFirstByte, median | — | _pending_ |
| Barge-in: playback flushed promptly, no stale tail | yes | _pending_ |
| 5-min session: disconnects / drift / backlog | none | _pending_ |
| 5-min session: memory growth (tab / backend) | bounded | _pending_ |
| Cost per minute (measured usage) | — | _pending_ |

## Results — Cascade (Anthropic MT swap)

Same conversation script with `TRANSLATION_PROVIDER=anthropic`; primarily
validates the swap end-to-end (#17) and captures the MT stage's latency delta.

| Metric | Measured |
| --- | --- |
| sttFinal → mtFirstToken, median (claude-haiku-4-5) | _pending_ |
| End-to-end, median | _pending_ |
| Any behavior differences noted | _pending_ |

## Gaps and causes

_Fill in if any target is missed: the gap, the stage responsible (from the
per-stage breakdown), and the suspected cause._
