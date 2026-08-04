import { pcm16LeToFloat32 } from './audioDecoding';
import type { CascadeAudioEvent } from './CascadeSessionController';

/** Collaborator the queue needs, swappable in tests for jsdom's lack of a real Web Audio API. */
export interface AudioPlaybackQueueDeps {
  /** Creates a fresh AudioContext, lazily, the first time this queue needs one. */
  createAudioContext: () => AudioContext;
}

function defaultDeps(): AudioPlaybackQueueDeps {
  return { createAudioContext: () => new AudioContext() };
}

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

  constructor(deps: Partial<AudioPlaybackQueueDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  /**
   * Feeds one audio event from `CascadeSessionController.subscribeToAudio`
   * into the queue. `'start'` just records the format for the chunks that
   * follow; the scheduling cursor is deliberately *not* reset here — an
   * utterance boundary shouldn't introduce a gap (or worse, a jump backward)
   * if the previous utterance's audio is still scheduled to play out, and
   * the `max()` in {@link enqueueChunk} already handles the "queue ran dry"
   * case on its own. `'end'` is a no-op: the chunks already scheduled keep
   * playing on their own schedule regardless.
   */
  handleEvent(event: CascadeAudioEvent): void {
    switch (event.kind) {
      case 'start':
        this.currentSampleRateHz = event.sampleRateHz;
        break;
      case 'chunk':
        this.enqueueChunk(event.data);
        break;
      case 'end':
        break;
    }
  }

  /** Decodes one PCM16LE chunk and schedules it immediately after whatever's already queued. */
  private enqueueChunk(data: ArrayBuffer): void {
    if (data.byteLength === 0) return; // An empty binary frame would make Web Audio reject a zero-length AudioBuffer.

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
  }

  /** Lazily creates the AudioContext this queue schedules chunks against. */
  private ensureContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = this.deps.createAudioContext();
      this.nextStartTime = this.audioContext.currentTime;
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

    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }
  }
}
