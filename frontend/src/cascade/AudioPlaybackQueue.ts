import { pcm16LeToFloat32 } from './audioDecoding';
import type { CascadeAudioEvent } from './CascadeSessionController';

/** Collaborators the queue needs, swappable in tests for jsdom's lack of a real Web Audio API/`performance.now()` determinism. */
export interface AudioPlaybackQueueDeps {
  /** Creates a fresh AudioContext, lazily, the first time this queue needs one. */
  createAudioContext: () => AudioContext;
  /** The local (client) clock used for first-chunk latency timing (issue #10) — real `performance.now()` in production. */
  now: () => number;
}

function defaultDeps(): AudioPlaybackQueueDeps {
  return { createAudioContext: () => new AudioContext(), now: () => performance.now() };
}

/**
 * One utterance's TTS-chunk local-clock timing (issue #10): the span from
 * when its first audio chunk was received off the wire to when Web Audio
 * actually schedules it to become audible. Both ends of this span are read
 * from the same local clock (`AudioPlaybackQueueDeps.now`) — never a
 * server timestamp — so the resulting `clientReceiveToAudibleMs` is always a
 * same-clock subtraction, per the clock-discipline issue #10 specifies.
 */
export interface FirstChunkTiming {
  /** The utteranceId as seen on `CascadeAudioEvent` — the *target*-lane id, not the source-lane id `latency.mark`s use (see `cascadeLatencyAdapter.ts`'s `toSourceUtteranceId`). */
  utteranceId: string;
  clientReceiveToAudibleMs: number;
  /**
   * The local-clock moment this utterance's first audio actually becomes
   * audible — the closing edge of the brief's perceived-latency window. The
   * span above only describes the playback leg; this absolute reading is what
   * lets the tracker measure the whole window on one clock, wire time included.
   */
  audibleAtMs: number;
}

type FirstChunkTimingListener = (timing: FirstChunkTiming) => void;

/**
 * Schedules a stream of raw PCM16LE mono TTS (Text-to-Speech) audio chunks —
 * fed one at a time via {@link handleEvent} from
 * `CascadeSessionController.subscribeToAudio` — for gapless Web Audio
 * playback.
 *
 * Each chunk is decoded into its own `AudioBuffer` (created at the format's
 * *own* sample rate, e.g. 24kHz; the `AudioContext` resamples to its native
 * rate — typically 44.1/48kHz — automatically on playback, which is the
 * standard way to get sample-rate conversion "for free" without writing a
 * resampler here) and scheduled back-to-back via a running `nextStartTime`
 * cursor: `source.start(Math.max(audioContext.currentTime, nextStartTime))`.
 * That single `max()` does double duty:
 * - Back-to-back chunks (the common case, arriving faster than they play
 *   out): `nextStartTime` is already ahead of `currentTime`, so each new
 *   chunk starts exactly where the previous one ends — no gap, no overlap.
 * - The queue running dry (a chunk arrives late, after everything already
 *   scheduled has finished playing): `currentTime` has moved past
 *   `nextStartTime`, so the new chunk starts immediately (a brief silent
 *   gap the listener hears) rather than "catching up" by starting in the
 *   past, which `AudioBufferSourceNode.start` would just clamp to "now"
 *   anyway.
 *
 * Not itself unit tested against a real `AudioContext` — jsdom (the test
 * environment) doesn't implement one. Tests inject a fake
 * `createAudioContext` via {@link AudioPlaybackQueueDeps} instead.
 */
export class AudioPlaybackQueue {
  private readonly deps: AudioPlaybackQueueDeps;
  private audioContext: AudioContext | null = null;
  /** AudioContext-clock timestamp (seconds) the next scheduled chunk should start at — the running cursor described above. */
  private nextStartTime = 0;
  /** Sample rate of the utterance currently in flight, echoed on its `tts.audio.start` event. */
  private currentSampleRateHz = 24_000;
  private readonly activeSources = new Set<AudioBufferSourceNode>();
  private readonly firstChunkListeners = new Set<FirstChunkTimingListener>();
  /** Set on `'start'` to the utteranceId whose *next* chunk (its first) should report {@link FirstChunkTiming}; cleared once that report fires, so later chunks of the same utterance don't re-report. */
  private pendingFirstChunkUtteranceId: string | null = null;
  /**
   * utteranceId of whatever audio window is currently open — set on
   * `'start'`, cleared on `'end'` or a successful {@link flush} — used by
   * {@link flush} (issue #11) to decide whether a barge-in actually affects
   * anything this queue has scheduled. Per the backend's framing guarantee
   * (issue #7), TTS audio for different utterances is never interleaved, so
   * at most one utterance's chunks are ever active at once; tracking just
   * this single id — rather than a per-source map — is enough to know
   * whether a barge-in's superseded ids match what's actually playing.
   */
  private currentUtteranceId: string | null = null;
  /** `deps.now()` reading and AudioContext `currentTime` reading taken together when the current AudioContext was created — the anchor {@link enqueueChunk} uses to translate an AudioContext-clock schedule time into an equivalent local-clock (`deps.now()`) instant, since both clocks advance in lockstep once anchored (both track real elapsed time from that shared instant). */
  private contextAnchorNowMs = 0;
  private contextAnchorTime = 0;

  constructor(deps: Partial<AudioPlaybackQueueDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  /**
   * Feeds one audio event from `CascadeSessionController.subscribeToAudio`
   * into the queue. `'start'` records the format for the chunks that
   * follow and arms the next chunk to report its {@link FirstChunkTiming};
   * the scheduling cursor is deliberately *not* reset here — an utterance
   * boundary shouldn't introduce a gap (or worse, a jump backward) if the
   * previous utterance's audio is still scheduled to play out, and the
   * `max()` in {@link enqueueChunk} already handles the "queue ran dry" case
   * on its own. `'end'` clears which utterance is "currently open" (so a
   * later barge-in naming this same id is a no-op — it finished normally,
   * nothing to flush) but is otherwise a no-op: the chunks already scheduled
   * keep playing on their own schedule regardless. `'bargein'` (issue #11)
   * delegates to {@link flush}.
   */
  handleEvent(event: CascadeAudioEvent): void {
    switch (event.kind) {
      case 'start':
        this.currentSampleRateHz = event.sampleRateHz;
        this.pendingFirstChunkUtteranceId = event.utteranceId;
        this.currentUtteranceId = event.utteranceId;
        break;
      case 'chunk':
        this.enqueueChunk(event.data, event.utteranceId);
        break;
      case 'end':
        if (this.currentUtteranceId === event.utteranceId) {
          this.currentUtteranceId = null;
        }
        break;
      case 'bargein':
        this.flush(event.supersededUtteranceIds);
        break;
    }
  }

  /**
   * Interrupts playback for a barge-in (issue #11): stops and discards
   * *every* scheduled-but-unfinished source and resets the cursor to "now,"
   * so the very next enqueued chunk — typically the utterance whose speech
   * onset triggered this barge-in — starts audibly immediately rather than
   * waiting out whatever was left queued.
   *
   * Deliberately unconditional on `currentUtteranceId` rather than gated on
   * it appearing in `supersededUtteranceIds`: the backend only lists
   * still-*pending* utterances there, so an utterance that already received
   * its `'end'` event (and so cleared `currentUtteranceId`) never appears —
   * yet its tail chunks can still be scheduled and audible here, since audio
   * scheduling runs ahead of the event stream. Everything this queue has
   * scheduled by the time any barge-in arrives necessarily predates it, so
   * a non-empty `supersededUtteranceIds` list (i.e. an actual barge-in, not
   * a no-op call) is reason enough to flush all of it — otherwise stale TTS
   * audio keeps talking over the caller after they've interrupted.
   *
   * A no-op only when `supersededUtteranceIds` is empty (nothing to flush).
   *
   * Unlike {@link stop}, the AudioContext itself is left open — a barge-in
   * is mid-session, not a session teardown — so the next utterance's audio
   * can be scheduled without paying to reopen a fresh context.
   */
  flush(supersededUtteranceIds: readonly string[]): void {
    if (supersededUtteranceIds.length === 0) return;

    for (const source of this.activeSources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already finished/stopped on its own; nothing further to do.
      }
      source.disconnect();
    }
    this.activeSources.clear();

    if (this.audioContext) {
      this.nextStartTime = this.audioContext.currentTime;
    }
    if (this.pendingFirstChunkUtteranceId === this.currentUtteranceId) {
      this.pendingFirstChunkUtteranceId = null;
    }
    this.currentUtteranceId = null;
  }

  /**
   * Subscribes to {@link FirstChunkTiming} — one sample per utterance, fired
   * the moment its first non-empty chunk is scheduled. Returns an
   * unsubscribe function.
   */
  subscribeToFirstChunkTiming(listener: FirstChunkTimingListener): () => void {
    this.firstChunkListeners.add(listener);
    return () => {
      this.firstChunkListeners.delete(listener);
    };
  }

  /** Decodes one PCM16LE chunk and schedules it immediately after whatever's already queued. */
  private enqueueChunk(data: ArrayBuffer, utteranceId: string): void {
    if (data.byteLength === 0) return; // An empty binary frame would make Web Audio reject a zero-length AudioBuffer.

    const receivedAtMs = this.deps.now();
    const audioContext = this.ensureContext();
    const samples = pcm16LeToFloat32(data);

    const buffer = audioContext.createBuffer(1, samples.length, this.currentSampleRateHz);
    buffer.copyToChannel(samples, 0);

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.onended = () => {
      this.activeSources.delete(source);
    };

    const startTime = Math.max(audioContext.currentTime, this.nextStartTime);
    source.start(startTime);
    this.nextStartTime = startTime + buffer.duration;
    this.activeSources.add(source);

    if (this.pendingFirstChunkUtteranceId === utteranceId) {
      this.pendingFirstChunkUtteranceId = null;
      // Both terms below come from this queue's own local clock (`receivedAtMs`
      // directly; `audibleAtMs` via the AudioContext-anchor translation) — never a
      // server timestamp — so this subtraction never mixes clocks (issue #10).
      const audibleAtMs = this.contextAnchorNowMs + (startTime - this.contextAnchorTime) * 1000;
      const clientReceiveToAudibleMs = audibleAtMs - receivedAtMs;
      for (const listener of this.firstChunkListeners) {
        listener({ utteranceId, clientReceiveToAudibleMs, audibleAtMs });
      }
    }
  }

  /** Lazily creates the AudioContext this queue schedules chunks against. */
  private ensureContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = this.deps.createAudioContext();
      this.nextStartTime = this.audioContext.currentTime;
      this.contextAnchorNowMs = this.deps.now();
      this.contextAnchorTime = this.audioContext.currentTime;
    }
    if (this.audioContext.state === 'suspended') {
      // A context created outside a user-activation window (e.g. the first
      // chunk of a session arriving asynchronously, off the click/tap that
      // started it) can come up suspended; resuming is cheap and idempotent,
      // so it's safe to attempt on every call rather than tracking whether
      // we've already tried.
      void this.audioContext.resume();
    }
    return this.audioContext;
  }

  /**
   * Immediately silences every scheduled-but-unfinished chunk and closes the
   * AudioContext, releasing it entirely — mirrors `MicPcmCapture.stop()` so
   * a session's audio pipeline (capture and playback alike) is fully torn
   * down and safe to start fresh next time, with nothing left running and no
   * AudioContext leaked. Safe to call on a queue that never played
   * anything (e.g. an utterance with no synthesizable text).
   */
  async stop(): Promise<void> {
    for (const source of this.activeSources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already finished/stopped on its own; nothing further to do.
      }
      source.disconnect();
    }
    this.activeSources.clear();
    this.nextStartTime = 0;
    this.pendingFirstChunkUtteranceId = null;
    this.currentUtteranceId = null;

    // Capture-and-null before the async close() so a concurrent second
    // stop() call (e.g. both a barge-in cleanup path and an explicit
    // session teardown racing each other) sees `this.audioContext` already
    // cleared and skips closing an already-closing/closed context — closing
    // it twice throws, and since nothing awaits that second call's promise
    // it would surface as an unhandled rejection.
    const ctx = this.audioContext;
    this.audioContext = null;
    if (ctx && ctx.state !== 'closed') {
      await ctx.close().catch(() => {});
    }
  }
}
