import { describe, expect, it } from 'vitest';
import { RealtimeLatencyTracker } from '../latency/realtimeLatencyAdapter';

/** Feeds one typed data-channel event at a given local time. */
function feed(tracker: RealtimeLatencyTracker, type: string, nowMs: number) {
  return tracker.handleEvent({ type }, nowMs);
}

describe('RealtimeLatencyTracker', () => {
  // Catches the shipped bug where pairing on the audio element's once-per-session
  // `playing` event left the latency panel permanently at "No utterances yet":
  // turns must complete on the per-response output_audio_buffer.started event.
  it('reports a turn when output_audio_buffer.started follows speech_stopped, split into responseCreated/audioStart spans', () => {
    const tracker = new RealtimeLatencyTracker();
    feed(tracker, 'input_audio_buffer.speech_stopped', 1_000);
    feed(tracker, 'response.created', 1_400);

    const report = feed(tracker, 'output_audio_buffer.started', 1_650);

    expect(report).toEqual({
      utteranceId: 'turn-1',
      stages: [
        { stage: 'responseCreated', ms: 400 },
        { stage: 'audioStart', ms: 250 },
      ],
      endToEndMs: 650,
    });
  });

  // Catches a turn with no observed response.created fabricating a zero-length
  // stage instead of omitting the breakdown.
  it('omits the stage breakdown when no response.created was observed for the turn', () => {
    const tracker = new RealtimeLatencyTracker();
    feed(tracker, 'input_audio_buffer.speech_stopped', 1_000);

    const report = feed(tracker, 'output_audio_buffer.started', 1_650);

    expect(report).toEqual({ utteranceId: 'turn-1', stages: [], endToEndMs: 650 });
  });

  // Catches audio starting with no preceding speech (a model response the user
  // never prompted) fabricating a measurement.
  it('returns null when output_audio_buffer.started fires with no pending speech_stopped anchor', () => {
    const tracker = new RealtimeLatencyTracker();

    expect(feed(tracker, 'output_audio_buffer.started', 1_000)).toBeNull();
  });

  // Catches a consumed anchor being reused by a later audio start, reporting a
  // nonsensical span for an unrelated response.
  it('consumes the pending anchor so a second output_audio_buffer.started does not reuse it', () => {
    const tracker = new RealtimeLatencyTracker();
    feed(tracker, 'input_audio_buffer.speech_stopped', 1_000);
    feed(tracker, 'output_audio_buffer.started', 1_500);

    expect(feed(tracker, 'output_audio_buffer.started', 3_000)).toBeNull();
  });

  // Catches a stale turn (response cancelled or silent) contaminating the next
  // turn's measurement when the speaker talks again.
  it('re-anchors on a new speech_stopped, discarding an incomplete previous turn', () => {
    const tracker = new RealtimeLatencyTracker();
    feed(tracker, 'input_audio_buffer.speech_stopped', 1_000);
    feed(tracker, 'response.created', 1_200);
    feed(tracker, 'input_audio_buffer.speech_stopped', 5_000);
    feed(tracker, 'response.created', 5_300);

    const report = feed(tracker, 'output_audio_buffer.started', 5_500);

    expect(report).toEqual({
      utteranceId: 'turn-1',
      stages: [
        { stage: 'responseCreated', ms: 300 },
        { stage: 'audioStart', ms: 200 },
      ],
      endToEndMs: 500,
    });
  });

  // Catches every turn sharing one id, which would collapse separate utterances
  // into a single report in the recent-N breakdown.
  it('mints a new incrementing turn id for each successive measurement', () => {
    const tracker = new RealtimeLatencyTracker();
    feed(tracker, 'input_audio_buffer.speech_stopped', 1_000);
    const first = feed(tracker, 'output_audio_buffer.started', 1_200);
    feed(tracker, 'input_audio_buffer.speech_stopped', 2_000);
    const second = feed(tracker, 'output_audio_buffer.started', 2_300);

    expect(first?.utteranceId).toBe('turn-1');
    expect(second?.utteranceId).toBe('turn-2');
  });

  // Catches unrelated or malformed data-channel events throwing or being mistaken
  // for a boundary event.
  it('ignores unrelated or malformed events', () => {
    const tracker = new RealtimeLatencyTracker();

    expect(() => tracker.handleEvent({ type: 'response.output_audio_transcript.delta' }, 1_000)).not.toThrow();
    expect(() => tracker.handleEvent(null, 1_000)).not.toThrow();
    expect(feed(tracker, 'output_audio_buffer.started', 2_000)).toBeNull();
  });

  // Catches a leftover anchor from a previous conversation pairing with a
  // brand-new session's audio start after reset().
  it('reset() clears any pending turn state', () => {
    const tracker = new RealtimeLatencyTracker();
    feed(tracker, 'input_audio_buffer.speech_stopped', 1_000);
    feed(tracker, 'response.created', 1_100);
    tracker.reset();

    expect(feed(tracker, 'output_audio_buffer.started', 5_000)).toBeNull();

    feed(tracker, 'input_audio_buffer.speech_stopped', 6_000);
    const report = feed(tracker, 'output_audio_buffer.started', 6_200);
    expect(report).toEqual({ utteranceId: 'turn-1', stages: [], endToEndMs: 200 });
  });

  // Catches a post-reset turn reusing a pre-reset id: latency history is preserved
  // across reconnects, so a collision overwrites the old report in place and
  // corrupts session-average math.
  it('mints a turn id distinct from pre-reset turns, so reconnects do not collide with preserved latency history', () => {
    const tracker = new RealtimeLatencyTracker();
    feed(tracker, 'input_audio_buffer.speech_stopped', 1_000);
    const beforeReset = feed(tracker, 'output_audio_buffer.started', 1_200);

    tracker.reset();

    feed(tracker, 'input_audio_buffer.speech_stopped', 6_000);
    const afterReset = feed(tracker, 'output_audio_buffer.started', 6_200);

    expect(beforeReset?.utteranceId).toBe('turn-1');
    expect(afterReset?.utteranceId).not.toBe(beforeReset?.utteranceId);
  });
});
