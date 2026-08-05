import type { LatencyReport, LatencyStageTiming } from './types';

/**
 * Realtime mode's latency instrumentation (issue #10). No backend visibility
 * into a direct browser<->OpenAI WebRTC session, so everything observable
 * arrives on the `oai-events` data channel. Three boundaries per turn:
 * `input_audio_buffer.speech_stopped` (VAD says the speaker finished — the
 * anchor), `response.created` (model began responding), and
 * `output_audio_buffer.started` (server began sending the response's audio —
 * completes the measurement).
 *
 * `output_audio_buffer.started` replaces an earlier pairing against the remote
 * `<audio>` element's `playing` event, which fires exactly once per WebRTC
 * session (a live remote track streams continuously, silence included, so the
 * element never re-buffers between turns) — leaving every turn unmeasured.
 *
 * `endToEndMs` slightly understates perceived latency: it ends when the server
 * starts sending audio, not when it's audible (network + jitter-buffer playout
 * excluded) — actual audibility isn't observable per turn. Events carry no id
 * linking one turn's boundaries, so they pair by recency, and turns get
 * synthetic ids (`turn-1`, ...). All boundaries read the same injected local
 * clock — every number is a same-clock subtraction, per the clock discipline
 * the cascade adapter also follows.
 */
export class RealtimeLatencyTracker {
  private pendingSpeechStoppedAtMs: number | null = null;
  private responseCreatedAtMs: number | null = null;
  private turnCounter = 0;

  /**
   * Clears pending turn state for a fresh session. Deliberately keeps
   * `turnCounter`: latency history is preserved across reconnects/mode
   * switches upstream, and a restarted counter would mint a `turn-1` that
   * collides with the preserved pre-reset `turn-1` in the shared reducer.
   */
  reset(): void {
    this.pendingSpeechStoppedAtMs = null;
    this.responseCreatedAtMs = null;
  }

  /**
   * Feeds one parsed data-channel event; returns a completed turn's report
   * when the event closes out a pending turn, else `null`. `stages` is empty
   * (never zero placeholders) if no `response.created` was observed.
   */
  handleEvent(rawEvent: unknown, nowMs: number): LatencyReport | null {
    if (typeof rawEvent !== 'object' || rawEvent === null) return null;
    const type = (rawEvent as { type?: unknown }).type;

    if (type === 'input_audio_buffer.speech_stopped') {
      // Re-anchor even if the previous turn never completed (cancelled or
      // silent response) — stale turns are abandoned, not reported.
      this.pendingSpeechStoppedAtMs = nowMs;
      this.responseCreatedAtMs = null;
      return null;
    }

    if (type === 'response.created') {
      if (this.pendingSpeechStoppedAtMs !== null && this.responseCreatedAtMs === null) {
        this.responseCreatedAtMs = nowMs;
      }
      return null;
    }

    if (type === 'output_audio_buffer.started') {
      if (this.pendingSpeechStoppedAtMs === null) return null;

      const stages: LatencyStageTiming[] =
        this.responseCreatedAtMs !== null
          ? [
              { stage: 'responseCreated', ms: this.responseCreatedAtMs - this.pendingSpeechStoppedAtMs },
              { stage: 'audioStart', ms: nowMs - this.responseCreatedAtMs },
            ]
          : [];
      const endToEndMs = nowMs - this.pendingSpeechStoppedAtMs;

      this.pendingSpeechStoppedAtMs = null;
      this.responseCreatedAtMs = null;
      this.turnCounter += 1;

      return { utteranceId: `turn-${this.turnCounter}`, stages, endToEndMs };
    }

    return null;
  }
}
