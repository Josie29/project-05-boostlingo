import type { LatencyReport } from './types';

/**
 * Realtime mode's latency instrumentation (issue #10) is necessarily
 * coarser than cascade's: the backend has no visibility into a direct
 * browser<->OpenAI WebRTC session (it only mints the ephemeral token), so
 * there are no per-pipeline-stage server marks to fold. Only two boundaries
 * are observable at all, both client-side:
 *
 * - `input_audio_buffer.speech_stopped` — a data-channel event OpenAI's own
 *   VAD (Voice Activity Detection) fires the instant it detects the speaker
 *   stopped talking. `RealtimeSessionController.subscribeToEvents` already
 *   forwards this unfiltered, same as every other data-channel event.
 *   (`input_audio_buffer.committed`, the event `OpenAiSttProvider` uses
 *   server-side for cascade's own `speechEnd` mark, carries an `item_id` an
 *   equivalent Realtime-side handler *could* key off of, but this tracker
 *   doesn't need one — see below.)
 * - the remote `<audio>` element (`RealtimeSessionController.getAudioElement()`)
 *   actually starting playback. `ontrack` assigns the remote stream to it
 *   once, during negotiation; from then on, the standard `playing` media
 *   event fires every time playback *resumes* after a pause or buffering
 *   stall — in practice, once per spoken turn, since silence between turns
 *   starves the element until the next response's audio arrives.
 *
 * Unlike cascade's shared source-lane `utteranceId`, there is no id linking
 * one turn's `speech_stopped` to the `playing` event it causes. This
 * tracker pairs them purely by recency — the latest `speech_stopped` and
 * the next `playing` after it — which produces one coarse, per-turn
 * measurement with no stage breakdown (`stages` is always empty; only
 * `endToEndMs` is populated). Utterances are given a synthetic, incrementing
 * id (`turn-1`, `turn-2`, ...) purely so the shared `LatencyReport`/reducer
 * shape still has something to key by.
 *
 * Both boundaries are read with the browser's own clock
 * (`performance.now()`, injected as `now` for tests) — never OpenAI's or
 * the backend's — so `endToEndMs` here is a single same-clock subtraction,
 * consistent with the clock-discipline the cascade adapter also follows.
 */
export class RealtimeLatencyTracker {
  private pendingSpeechStoppedAtMs: number | null = null;
  private turnCounter = 0;

  /**
   * Clears any pending `speech_stopped` anchor, for a fresh session.
   *
   * Deliberately does *not* reset `turnCounter`: `useInterpreterSession`
   * intentionally preserves latency history across reconnects and
   * mode-switches, and `LatencyReport.utteranceId` values are threaded
   * through a mode-prefixing step upstream that only de-dupes *within* a
   * mode, not across a `reset()` call. If the counter restarted at 0 here,
   * a post-reset `turn-1` would collide with the pre-reset `turn-1` still
   * sitting in that preserved history, and the latency reducer would treat
   * the new turn as an update to the old report instead of a new one.
   */
  reset(): void {
    this.pendingSpeechStoppedAtMs = null;
  }

  /**
   * Feeds one raw, already-JSON-parsed Realtime data-channel event. Only
   * `input_audio_buffer.speech_stopped` is observed; every other event type
   * (transcripts, response lifecycle, etc.) is ignored here — other
   * adapters handle those.
   */
  handleEvent(rawEvent: unknown, nowMs: number): void {
    if (typeof rawEvent !== 'object' || rawEvent === null) return;
    const type = (rawEvent as { type?: unknown }).type;
    if (type === 'input_audio_buffer.speech_stopped') {
      this.pendingSpeechStoppedAtMs = nowMs;
    }
  }

  /**
   * Called when the remote `<audio>` element's `playing` event fires.
   * Returns a coarse {@link LatencyReport} if there's a pending
   * `speech_stopped` anchor to pair it with, or `null` otherwise (e.g. a
   * `playing` event firing for reasons unrelated to a spoken turn, or one
   * that already got consumed by an earlier `playing` event).
   */
  handleAudioPlaying(nowMs: number): LatencyReport | null {
    if (this.pendingSpeechStoppedAtMs === null) return null;

    const endToEndMs = nowMs - this.pendingSpeechStoppedAtMs;
    this.pendingSpeechStoppedAtMs = null;
    this.turnCounter += 1;

    return { utteranceId: `turn-${this.turnCounter}`, stages: [], endToEndMs };
  }
}
