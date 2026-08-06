import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioPlaybackQueue } from '../cascade/AudioPlaybackQueue';
import type { AudioPlaybackQueueDeps } from '../cascade/AudioPlaybackQueue';

/** A fake `AudioBufferSourceNode` covering just the surface `AudioPlaybackQueue` touches. */
interface FakeSource {
  buffer: unknown;
  onended: (() => void) | null;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

/** A fake `AudioBuffer` covering just the surface `AudioPlaybackQueue` touches. */
interface FakeBuffer {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  duration: number;
  copyToChannel: ReturnType<typeof vi.fn>;
}

/**
 * The surface `AudioPlaybackQueue` actually touches on an `AudioContext` —
 * a standalone type (not `AudioContext & {...}`) so `currentTime` stays
 * mutable here instead of inheriting the real DOM type's `readonly`, the
 * same trick `CascadeSessionController.test.ts`'s `FakeWebSocket` uses for
 * `readyState`. Cast to `AudioContext` via {@link toAudioContext} wherever
 * the real type is required.
 */
interface FakeAudioContext {
  currentTime: number;
  destination: object;
  state: AudioContextState;
  createBuffer: ReturnType<typeof vi.fn>;
  createBufferSource: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
}

function toAudioContext(ctx: FakeAudioContext): AudioContext {
  return ctx as unknown as AudioContext;
}

/**
 * A fake `AudioContext` whose `currentTime` a test can move forward by hand
 * (simulating real playback time passing) since jsdom implements no real
 * Web Audio API. `createBufferSource()` records every source it creates so
 * tests can assert on the exact `start(when)` time each was scheduled at.
 */
function fakeAudioContext(startingCurrentTime = 0, startingState: AudioContextState = 'running') {
  const sources: FakeSource[] = [];
  const buffers: FakeBuffer[] = [];

  const ctx: FakeAudioContext = {
    currentTime: startingCurrentTime,
    destination: {},
    state: startingState,
    createBuffer: vi.fn((numberOfChannels: number, length: number, sampleRate: number): FakeBuffer => {
      const buffer: FakeBuffer = { numberOfChannels, length, sampleRate, duration: length / sampleRate, copyToChannel: vi.fn() };
      buffers.push(buffer);
      return buffer;
    }),
    createBufferSource: vi.fn((): FakeSource => {
      const source: FakeSource = {
        buffer: null,
        onended: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      sources.push(source);
      return source;
    }),
    close: vi.fn(async () => {
      ctx.state = 'closed';
    }),
    resume: vi.fn(async () => {
      ctx.state = 'running';
    }),
  };

  return { ctx, sources, buffers };
}

/** Builds a silent raw PCM16LE chunk of `sampleCount` samples, at 24kHz that's `sampleCount / 24000` seconds. */
function pcmChunkOf(sampleCount: number): ArrayBuffer {
  return new ArrayBuffer(sampleCount * 2);
}

function buildQueue(overrides: Partial<AudioPlaybackQueueDeps> = {}) {
  const { ctx, sources, buffers } = fakeAudioContext();
  const queue = new AudioPlaybackQueue({ createAudioContext: () => toAudioContext(ctx), ...overrides });
  return { queue, ctx, sources, buffers };
}

describe('AudioPlaybackQueue', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // Catches the bug this queue exists to prevent: if the first chunk waited
  // for anything other than "now," there'd be a dead-air delay before TTS
  // audio starts, even though the spec calls for starting playback as soon
  // as the first chunk arrives.
  it('starts the first chunk immediately at the AudioContext current time', () => {
    const { queue, ctx, sources } = buildQueue();
    ctx.currentTime = 2.5;

    queue.handleEvent({ kind: 'start', utteranceId: 'u1', sampleRateHz: 24_000 });
    queue.handleEvent({ kind: 'chunk', utteranceId: 'u1', data: pcmChunkOf(24_000) });

    expect(sources).toHaveLength(1);
    expect(sources[0].start).toHaveBeenCalledWith(2.5);
  });

  // Catches the core scheduling bug: back-to-back chunks must butt up
  // exactly against each other (no silent gap, no overlapping/garbled
  // audio) — this is what "gapless playback" means in practice. If the
  // cursor advanced by the wrong amount, every multi-chunk utterance would
  // either stutter (gaps) or sound broken (overlap).
  it('schedules each subsequent chunk exactly when the previous one ends, with no gap or overlap', () => {
    const { queue, sources } = buildQueue();

    queue.handleEvent({ kind: 'start', utteranceId: 'u1', sampleRateHz: 24_000 });
    queue.handleEvent({ kind: 'chunk', utteranceId: 'u1', data: pcmChunkOf(24_000) }); // 1.0s
    queue.handleEvent({ kind: 'chunk', utteranceId: 'u1', data: pcmChunkOf(12_000) }); // 0.5s
    queue.handleEvent({ kind: 'chunk', utteranceId: 'u1', data: pcmChunkOf(6_000) }); // 0.25s

    expect(sources[0].start).toHaveBeenCalledWith(0);
    expect(sources[1].start).toHaveBeenCalledWith(1);
    expect(sources[2].start).toHaveBeenCalledWith(1.5);
  });

  // Catches a "starts in the past" bug: if a chunk arrives late (e.g. the
  // network stalled) after everything already scheduled has finished
  // playing, the cursor is behind the AudioContext's clock. Scheduling
  // against the stale cursor would either throw (Web Audio clamps `start`
  // to "now" but a naive cursor-only implementation might not) or silently
  // desync playback timing for every chunk after it.
  it('resumes at the current time (accepting a gap) rather than the stale cursor when the queue has run dry', () => {
    const { queue, ctx, sources } = buildQueue();

    queue.handleEvent({ kind: 'start', utteranceId: 'u1', sampleRateHz: 24_000 });
    queue.handleEvent({ kind: 'chunk', utteranceId: 'u1', data: pcmChunkOf(24_000) }); // scheduled [0, 1)
    expect(sources[0].start).toHaveBeenCalledWith(0);

    // Real playback time moves well past when the first chunk finished —
    // simulating a stall before the next chunk arrives.
    ctx.currentTime = 5;
    queue.handleEvent({ kind: 'chunk', utteranceId: 'u1', data: pcmChunkOf(24_000) });

    expect(sources[1].start).toHaveBeenCalledWith(5);
  });

  // Catches an endianness/scale bug in the capture->schedule pipeline: if
  // the PCM16LE bytes were decoded incorrectly before being handed to the
  // AudioBuffer, every utterance would play back as static/noise instead of
  // speech, with nothing in the transcript UI hinting at the problem.
  it("decodes each chunk's PCM16LE bytes into the exact Float32 samples handed to the AudioBuffer", () => {
    const { queue, buffers } = buildQueue();
    const chunk = new ArrayBuffer(4);
    new DataView(chunk).setInt16(0, 32767, true);
    new DataView(chunk).setInt16(2, -32768, true);

    queue.handleEvent({ kind: 'start', utteranceId: 'u1', sampleRateHz: 24_000 });
    queue.handleEvent({ kind: 'chunk', utteranceId: 'u1', data: chunk });

    expect(buffers[0].sampleRate).toBe(24_000);
    const decoded = buffers[0].copyToChannel.mock.calls[0][0] as Float32Array;
    expect(decoded[0]).toBe(1);
    expect(decoded[1]).toBe(-1);
  });

  // Catches a crash bug: an utterance with no synthesizable text (per the
  // backend's documented "not every utterance gets audio" behavior) sends
  // no chunks at all — a chunk handler must never assume it's been called at
  // least once. Also guards against a zero-length frame (defensive; the
  // protocol says "zero or more" binary frames) crashing Web Audio, which
  // rejects zero-length AudioBuffers.
  it('does not schedule anything for a zero-length chunk', () => {
    const { queue, sources } = buildQueue();

    queue.handleEvent({ kind: 'start', utteranceId: 'u1', sampleRateHz: 24_000 });
    queue.handleEvent({ kind: 'chunk', utteranceId: 'u1', data: new ArrayBuffer(0) });
    queue.handleEvent({ kind: 'end', utteranceId: 'u1' });

    expect(sources).toHaveLength(0);
  });

  // Catches the teardown bug this issue calls out explicitly: stopping a
  // session with audio still scheduled must silence it immediately, not let
  // already-scheduled sources keep playing out — a real annoyance for a
  // user who hits Stop mid-sentence expecting instant silence.
  it('stop() stops and disconnects every still-active source and closes the AudioContext', async () => {
    const { queue, ctx, sources } = buildQueue();
    queue.handleEvent({ kind: 'start', utteranceId: 'u1', sampleRateHz: 24_000 });
    queue.handleEvent({ kind: 'chunk', utteranceId: 'u1', data: pcmChunkOf(24_000) });
    queue.handleEvent({ kind: 'chunk', utteranceId: 'u1', data: pcmChunkOf(24_000) });

    await queue.stop();

    for (const source of sources) {
      expect(source.stop).toHaveBeenCalledOnce();
      expect(source.disconnect).toHaveBeenCalledOnce();
    }
    expect(ctx.close).toHaveBeenCalledOnce();
  });

  // Catches an accumulation/leak bug: repeated start/stop cycles (the normal
  // usage pattern — a user can start and stop a session many times) must
  // each close their own AudioContext and open a fresh one next time,
  // mirroring `MicPcmCapture`'s stop()/restart pattern, rather than reusing
  // a closed context (which would throw on every subsequent call) or
  // leaking one context per cycle.
  it('opens a fresh AudioContext on the next chunk after stop() closed the previous one', async () => {
    const contexts = [fakeAudioContext(), fakeAudioContext()];
    let call = 0;
    const queue = new AudioPlaybackQueue({ createAudioContext: () => toAudioContext(contexts[call++].ctx) });

    queue.handleEvent({ kind: 'start', utteranceId: 'u1', sampleRateHz: 24_000 });
    queue.handleEvent({ kind: 'chunk', utteranceId: 'u1', data: pcmChunkOf(24_000) });
    await queue.stop();

    queue.handleEvent({ kind: 'start', utteranceId: 'u2', sampleRateHz: 24_000 });
    queue.handleEvent({ kind: 'chunk', utteranceId: 'u2', data: pcmChunkOf(24_000) });
    await queue.stop();

    expect(contexts[0].ctx.close).toHaveBeenCalledOnce();
    expect(contexts[1].ctx.close).toHaveBeenCalledOnce();
    // The second utterance's chunk started at its own fresh context's time
    // (0), not carrying forward the first context's cursor — proof the two
    // sessions are fully independent rather than sharing leaked state.
    expect(contexts[1].sources[0].start).toHaveBeenCalledWith(0);
  });

  // Catches a double-stop crash: a source that already finished playing on
  // its own (browser fires `onended`, our handler removes it from the
  // active set) must not be stopped again when `stop()` runs — and even if
  // the browser itself throws calling `.stop()` on an already-stopped node,
  // that must not stop `stop()` from finishing its cleanup (closing the
  // context) for every other source.
  it('does not throw if a source throws on stop(), and still closes the AudioContext', async () => {
    const { queue, ctx, sources } = buildQueue();
    queue.handleEvent({ kind: 'start', utteranceId: 'u1', sampleRateHz: 24_000 });
    queue.handleEvent({ kind: 'chunk', utteranceId: 'u1', data: pcmChunkOf(24_000) });
    sources[0].stop.mockImplementation(() => {
      throw new Error('InvalidStateError: already stopped');
    });

    await expect(queue.stop()).resolves.toBeUndefined();
    expect(ctx.close).toHaveBeenCalledOnce();
  });

  // Catches a no-op-should-be-safe bug: stopping a queue that never received
  // any audio (e.g. a session where every utterance's MT/TTS failed) must
  // not try to close an AudioContext that was never created.
  it('stop() is a no-op that does not throw when no audio was ever scheduled', async () => {
    const queue = new AudioPlaybackQueue({ createAudioContext: () => toAudioContext(fakeAudioContext().ctx) });
    await expect(queue.stop()).resolves.toBeUndefined();
  });

  // Catches a double-close crash: two stop() calls racing (e.g. a barge-in
  // cleanup path and an explicit session teardown) must not both try to
  // close the same AudioContext — the real Web Audio API throws on a second
  // close(), which without guarding surfaces as an unhandled promise
  // rejection since nothing awaits the loser of the race.
  it('does not close the AudioContext twice when stop() is called concurrently', async () => {
    const { queue, ctx } = buildQueue();
    queue.handleEvent({ kind: 'start', utteranceId: 'u1', sampleRateHz: 24_000 });
    queue.handleEvent({ kind: 'chunk', utteranceId: 'u1', data: pcmChunkOf(24_000) });

    await Promise.all([queue.stop(), queue.stop()]);

    expect(ctx.close).toHaveBeenCalledOnce();
  });

  // Catches a silent-audio bug: an AudioContext created outside a
  // user-activation window (e.g. the first TTS chunk of a session arriving
  // asynchronously, off the click/tap that started it) can come up
  // suspended, in which case nothing scheduled against it is ever actually
  // audible until something resumes it.
  it('resumes the AudioContext if it comes up suspended', () => {
    const { ctx: rawCtx } = fakeAudioContext(0, 'suspended');
    const queue = new AudioPlaybackQueue({ createAudioContext: () => toAudioContext(rawCtx) });

    queue.handleEvent({ kind: 'start', utteranceId: 'u1', sampleRateHz: 24_000 });
    queue.handleEvent({ kind: 'chunk', utteranceId: 'u1', data: pcmChunkOf(24_000) });

    expect(rawCtx.resume).toHaveBeenCalled();
  });

  describe('flush (issue #11 barge-in)', () => {
    // Catches the core barge-in playback bug: if a superseded utterance's
    // already-scheduled chunks kept playing after a bargein envelope, the
    // caller would keep hearing the old (now-wrong) interpretation talk over
    // whatever comes next, defeating the whole point of barge-in.
    it('stops and disconnects every scheduled source for the utterance currently playing when it is named in supersededUtteranceIds', () => {
      const { queue, sources } = buildQueue();
      queue.handleEvent({ kind: 'start', utteranceId: 'u1', sampleRateHz: 24_000 });
      queue.handleEvent({ kind: 'chunk', utteranceId: 'u1', data: pcmChunkOf(24_000) });
      queue.handleEvent({ kind: 'chunk', utteranceId: 'u1', data: pcmChunkOf(24_000) });

      queue.flush(['u1']);

      for (const source of sources) {
        expect(source.stop).toHaveBeenCalledOnce();
        expect(source.disconnect).toHaveBeenCalledOnce();
      }
    });

    // Catches the "dead air until the old utterance would have finished" bug:
    // without resetting the scheduling cursor, the next utterance's first
    // chunk would still be scheduled to start wherever the flushed
    // utterance's audio would have ended, producing a silent gap instead of
    // instant playback the moment the new utterance's audio arrives.
    it('resets the scheduling cursor so the next chunk (a new utterance) plays immediately', () => {
      const { queue, ctx, sources } = buildQueue();
      ctx.currentTime = 1;
      queue.handleEvent({ kind: 'start', utteranceId: 'u1', sampleRateHz: 24_000 });
      queue.handleEvent({ kind: 'chunk', utteranceId: 'u1', data: pcmChunkOf(24_000) }); // scheduled [1, 2)

      ctx.currentTime = 1.2; // barge-in happens partway through playback
      queue.flush(['u1']);

      queue.handleEvent({ kind: 'start', utteranceId: 'u2', sampleRateHz: 24_000 });
      queue.handleEvent({ kind: 'chunk', utteranceId: 'u2', data: pcmChunkOf(24_000) });

      expect(sources[1].start).toHaveBeenCalledWith(1.2);
    });

    // Catches the "flush tore down the whole audio pipeline" bug: unlike
    // stop() (a session teardown), a barge-in happens mid-session — closing
    // the AudioContext here would mean every subsequent utterance in the
    // same session pays to reopen one, and briefly has no audio destination
    // at all.
    it('does not close the AudioContext', () => {
      const { queue, ctx } = buildQueue();
      queue.handleEvent({ kind: 'start', utteranceId: 'u1', sampleRateHz: 24_000 });
      queue.handleEvent({ kind: 'chunk', utteranceId: 'u1', data: pcmChunkOf(24_000) });

      queue.flush(['u1']);

      expect(ctx.close).not.toHaveBeenCalled();
    });

    // Catches a regression back toward the old, narrower behavior: a real
    // barge-in (non-empty supersededUtteranceIds) must stop whatever this
    // queue currently has scheduled even if none of the named ids happen to
    // match this queue's own bookkeeping of "currently playing." Everything
    // scheduled in a given queue by the time any barge-in arrives predates
    // it by definition, so matching ids is not a precondition for flushing.
    it('stops the currently-playing utterance even when it is not itself named in supersededUtteranceIds', () => {
      const { queue, sources } = buildQueue();
      queue.handleEvent({ kind: 'start', utteranceId: 'u1', sampleRateHz: 24_000 });
      queue.handleEvent({ kind: 'chunk', utteranceId: 'u1', data: pcmChunkOf(24_000) });

      queue.flush(['some-other-utterance']);

      expect(sources[0].stop).toHaveBeenCalledOnce();
    });

    // Catches the no-real-barge-in case: an empty supersededUtteranceIds
    // list (nothing was actually superseded) must not touch anything
    // currently scheduled.
    it('is a no-op when supersededUtteranceIds is empty', () => {
      const { queue, sources } = buildQueue();
      queue.handleEvent({ kind: 'start', utteranceId: 'u1', sampleRateHz: 24_000 });
      queue.handleEvent({ kind: 'chunk', utteranceId: 'u1', data: pcmChunkOf(24_000) });

      queue.flush([]);

      expect(sources[0].stop).not.toHaveBeenCalled();
    });

    // Catches a crash/no-audio-yet edge case: a barge-in for an utterance
    // whose tts.audio.start hasn't produced any chunks yet (or arrived at
    // all) must not throw just because no AudioContext exists yet.
    it('is a no-op that does not throw when nothing has ever been scheduled', () => {
      const queue = new AudioPlaybackQueue({ createAudioContext: () => toAudioContext(fakeAudioContext().ctx) });

      expect(() => queue.flush(['u1'])).not.toThrow();
    });

    // Catches a "flush via handleEvent doesn't route correctly" bug: this is
    // how `CascadeInterpreterSession` actually delivers a barge-in in
    // production — through the same `handleEvent` channel as every other
    // audio event — so a 'bargein' case that didn't call flush() would leave
    // production wiring silently broken even with flush() itself well-tested.
    it("routes a 'bargein' CascadeAudioEvent through handleEvent to the same effect as calling flush() directly", () => {
      const { queue, ctx, sources } = buildQueue();
      queue.handleEvent({ kind: 'start', utteranceId: 'u1', sampleRateHz: 24_000 });
      queue.handleEvent({ kind: 'chunk', utteranceId: 'u1', data: pcmChunkOf(24_000) });

      queue.handleEvent({ kind: 'bargein', supersededUtteranceIds: ['u1'] });

      expect(sources[0].stop).toHaveBeenCalledOnce();
      expect(ctx.close).not.toHaveBeenCalled();
    });

    // Catches the exact stale-audio bug this fix addresses: the backend only
    // lists still-*pending* utterances in a bargein envelope, so an
    // utterance whose 'end' event already arrived (its window closed
    // normally on the frontend) never appears in supersededUtteranceIds —
    // yet its tail chunks can still be scheduled and audibly playing when
    // the barge-in happens, since audio scheduling runs ahead of the event
    // stream. If flush() still no-op'd here (the old, buggy behavior), that
    // stale audio would keep talking over the caller after they interrupted.
    it('still silences already-scheduled tail audio for an utterance whose window already closed via a natural end event', () => {
      const { queue, sources } = buildQueue();
      queue.handleEvent({ kind: 'start', utteranceId: 'u1', sampleRateHz: 24_000 });
      queue.handleEvent({ kind: 'chunk', utteranceId: 'u1', data: pcmChunkOf(24_000) });
      queue.handleEvent({ kind: 'end', utteranceId: 'u1' });

      queue.flush(['u2']);

      expect(sources[0].stop).toHaveBeenCalledOnce();
    });
  });

  describe('first-chunk timing (issue #10)', () => {
    // Catches the mixing-clock guard this measurement exists to satisfy: both the
    // "received" and "audible" instants must come from the same local clock
    // (`deps.now()`/the AudioContext-anchor translation), never a server timestamp —
    // and the reported span must reflect real queueing delay, not always be zero.
    // A second utterance whose audio is scheduled to start only once the first
    // utterance's backlog finishes playing (nextStartTime ahead of currentTime) is
    // exactly the case where that delay is nonzero and worth catching a regression in.
    it('reports a nonzero client receive-to-audible span when the new utterance must wait behind already-queued audio', () => {
      const now = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(500);
      const { queue, sources } = buildQueue({ now });
      const timings: unknown[] = [];
      queue.subscribeToFirstChunkTiming((timing) => timings.push(timing));

      queue.handleEvent({ kind: 'start', utteranceId: 'u1', sampleRateHz: 24_000 });
      queue.handleEvent({ kind: 'chunk', utteranceId: 'u1', data: pcmChunkOf(24_000) }); // schedules [0, 1)
      queue.handleEvent({ kind: 'start', utteranceId: 'u2', sampleRateHz: 24_000 });
      queue.handleEvent({ kind: 'chunk', utteranceId: 'u2', data: pcmChunkOf(24_000) }); // must wait until t=1

      expect(sources[1].start).toHaveBeenCalledWith(1);
      expect(timings).toEqual([
        { utteranceId: 'u1', clientReceiveToAudibleMs: 0, audibleAtMs: 0 },
        { utteranceId: 'u2', clientReceiveToAudibleMs: 500, audibleAtMs: 1000 },
      ]);
    });

    // Catches a double-report bug: only an utterance's *first* chunk should produce a
    // timing sample — later chunks of the same utterance are mid-stream, not a fresh
    // "how long until this utterance's audio started" measurement.
    it('does not report timing again for a second chunk of the same utterance', () => {
      const { queue } = buildQueue();
      const timings: unknown[] = [];
      queue.subscribeToFirstChunkTiming((timing) => timings.push(timing));

      queue.handleEvent({ kind: 'start', utteranceId: 'u1', sampleRateHz: 24_000 });
      queue.handleEvent({ kind: 'chunk', utteranceId: 'u1', data: pcmChunkOf(24_000) });
      queue.handleEvent({ kind: 'chunk', utteranceId: 'u1', data: pcmChunkOf(24_000) });

      expect(timings).toHaveLength(1);
    });

    // Catches an edge case the zero-length-chunk guard could otherwise break: a
    // leading empty binary frame (schedules nothing, per the existing zero-length
    // test above) must not itself count as "the first chunk" — the next *real* chunk
    // still owes a timing report.
    it('skips a zero-length leading chunk and reports timing on the next real one instead', () => {
      const { queue } = buildQueue();
      const timings: unknown[] = [];
      queue.subscribeToFirstChunkTiming((timing) => timings.push(timing));

      queue.handleEvent({ kind: 'start', utteranceId: 'u1', sampleRateHz: 24_000 });
      queue.handleEvent({ kind: 'chunk', utteranceId: 'u1', data: new ArrayBuffer(0) });
      queue.handleEvent({ kind: 'chunk', utteranceId: 'u1', data: pcmChunkOf(24_000) });

      expect(timings).toHaveLength(1);
      expect((timings[0] as { utteranceId: string }).utteranceId).toBe('u1');
    });

    // Catches an unsubscribe-doesn't-work bug: a listener that's already
    // unsubscribed must not still receive later timing samples.
    it('stops notifying a listener once unsubscribed', () => {
      const { queue } = buildQueue();
      const timings: unknown[] = [];
      const unsubscribe = queue.subscribeToFirstChunkTiming((timing) => timings.push(timing));
      unsubscribe();

      queue.handleEvent({ kind: 'start', utteranceId: 'u1', sampleRateHz: 24_000 });
      queue.handleEvent({ kind: 'chunk', utteranceId: 'u1', data: pcmChunkOf(24_000) });

      expect(timings).toHaveLength(0);
    });
  });
});
