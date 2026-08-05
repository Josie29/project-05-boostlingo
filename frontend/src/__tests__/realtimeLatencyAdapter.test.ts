import { describe, expect, it } from 'vitest';
import { RealtimeLatencyTracker } from '../latency/realtimeLatencyAdapter';

describe('RealtimeLatencyTracker', () => {
  // Catches the core mixing-clock guard this whole tracker exists to satisfy: both
  // ends of the measurement (speech_stopped's receipt, the audio element's playing
  // event) must come from the same local clock argument, so the resulting endToEndMs
  // is a plain same-clock subtraction — never a value derived from any server
  // timestamp, since Realtime mode has no backend visibility into the call at all.
  it('reports endToEndMs as the local-clock span from speech_stopped to the next playing event', () => {
    const tracker = new RealtimeLatencyTracker();
    tracker.handleEvent({ type: 'input_audio_buffer.speech_stopped' }, 1_000);

    const report = tracker.handleAudioPlaying(1_650);

    expect(report).toEqual({ utteranceId: 'turn-1', stages: [], endToEndMs: 650 });
  });

  // Catches a bug where a `playing` event with no preceding speech_stopped (e.g. one
  // firing for an unrelated reason) fabricates a bogus measurement instead of being
  // recognized as having nothing to pair with.
  it('returns null when playing fires with no pending speech_stopped anchor', () => {
    const tracker = new RealtimeLatencyTracker();

    expect(tracker.handleAudioPlaying(1_000)).toBeNull();
  });

  // Catches a double-counting bug: once a speech_stopped anchor has been consumed by
  // one playing event, a second playing event must not reuse the same stale anchor
  // and report a nonsensical (much larger) span for an unrelated turn.
  it('consumes the pending anchor so a second playing event does not reuse it', () => {
    const tracker = new RealtimeLatencyTracker();
    tracker.handleEvent({ type: 'input_audio_buffer.speech_stopped' }, 1_000);
    tracker.handleAudioPlaying(1_500);

    expect(tracker.handleAudioPlaying(3_000)).toBeNull();
  });

  // Catches a bug where every turn in a session gets the same id (or the counter never
  // advances), which would make the shared latency reducer treat every turn as
  // updates to one report instead of separate utterances in the recent-N breakdown.
  it('mints a new incrementing turn id for each successive measurement', () => {
    const tracker = new RealtimeLatencyTracker();
    tracker.handleEvent({ type: 'input_audio_buffer.speech_stopped' }, 1_000);
    const first = tracker.handleAudioPlaying(1_200);
    tracker.handleEvent({ type: 'input_audio_buffer.speech_stopped' }, 2_000);
    const second = tracker.handleAudioPlaying(2_300);

    expect(first?.utteranceId).toBe('turn-1');
    expect(second?.utteranceId).toBe('turn-2');
  });

  // Catches a crash/noise bug: unrelated data-channel events (transcripts, response
  // lifecycle, malformed frames) must be ignored rather than throwing or being
  // mistaken for a speech_stopped anchor.
  it('ignores unrelated or malformed events', () => {
    const tracker = new RealtimeLatencyTracker();

    expect(() => tracker.handleEvent({ type: 'response.output_audio_transcript.delta' }, 1_000)).not.toThrow();
    expect(() => tracker.handleEvent(null, 1_000)).not.toThrow();
    expect(tracker.handleAudioPlaying(2_000)).toBeNull();
  });

  // Catches a stale-anchor bug: a tracker reused across sessions (mirroring how
  // RealtimeInterpreterSession keeps one instance alive across start()/stop() cycles)
  // must not let a leftover speech_stopped anchor from a previous conversation pair
  // with a playing event from a brand-new one after reset().
  it('reset() clears any pending anchor', () => {
    const tracker = new RealtimeLatencyTracker();
    tracker.handleEvent({ type: 'input_audio_buffer.speech_stopped' }, 1_000);
    tracker.reset();

    expect(tracker.handleAudioPlaying(5_000)).toBeNull();

    tracker.handleEvent({ type: 'input_audio_buffer.speech_stopped' }, 6_000);
    const report = tracker.handleAudioPlaying(6_200);
    expect(report).toEqual({ utteranceId: 'turn-1', stages: [], endToEndMs: 200 });
  });

  // Catches a reconnect-corrupts-history bug: useInterpreterSession deliberately keeps
  // preserved latency reports across a reset() (reconnect/mode-switch), so a turn minted
  // after reset() must not reuse an id already used before it — otherwise the shared
  // latency reducer overwrites the preserved pre-reset report in place instead of adding
  // a distinct new one, silently corrupting session-average math.
  it('mints a turn id distinct from pre-reset turns, so reconnects do not collide with preserved latency history', () => {
    const tracker = new RealtimeLatencyTracker();
    tracker.handleEvent({ type: 'input_audio_buffer.speech_stopped' }, 1_000);
    const beforeReset = tracker.handleAudioPlaying(1_200);

    tracker.reset();

    tracker.handleEvent({ type: 'input_audio_buffer.speech_stopped' }, 6_000);
    const afterReset = tracker.handleAudioPlaying(6_200);

    expect(beforeReset?.utteranceId).toBe('turn-1');
    expect(afterReset?.utteranceId).not.toBe(beforeReset?.utteranceId);
  });
});
