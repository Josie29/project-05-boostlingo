import { describe, expect, it } from 'vitest';
import { CascadeLatencyTracker, toSourceUtteranceId } from '../latency/cascadeLatencyAdapter';

/** Builds one `latency.mark` envelope, matching `CascadeLatencyMarkPayload` (`backend/CascadeAudioSession.cs`). */
function mark(utteranceId: string, stage: string, serverTimeMs: number) {
  return { v: 1, type: 'latency.mark', payload: { utteranceId, stage, serverTimeMs } };
}

describe('CascadeLatencyTracker', () => {
  // Catches the core reduction bug: each stage's reported `ms` must be the
  // delta from the *previous* stage's mark, not a cumulative total or a raw
  // server timestamp — otherwise the breakdown table would show nonsense
  // (e.g. a huge Unix-epoch number, or the same growing total for every row).
  it('computes each stage as the delta from the nearest earlier mark', () => {
    const tracker = new CascadeLatencyTracker();
    tracker.handleEnvelope(mark('utt_1', 'speechEnd', 1_000));
    tracker.handleEnvelope(mark('utt_1', 'sttFirstPartial', 1_150));
    const report = tracker.handleEnvelope(mark('utt_1', 'sttFinal', 1_400));

    expect(report).toEqual({
      utteranceId: 'utt_1',
      stages: [
        { stage: 'sttFirstPartial', ms: 150 },
        { stage: 'sttFinal', ms: 250 },
      ],
      endToEndMs: null, // ttsFirstByte hasn't arrived yet.
    });
  });

  // Catches the "missing mark" bug the issue calls out explicitly: a dropped or
  // not-yet-arrived sttFirstPartial mark must not produce a NaN or a garbage
  // negative delta for sttFinal — it should just fall back to the nearest earlier
  // mark that *is* present (speechEnd here), same as if sttFirstPartial had never
  // been instrumented at all.
  it('falls back to the nearest earlier available mark when an intermediate stage is missing', () => {
    const tracker = new CascadeLatencyTracker();
    tracker.handleEnvelope(mark('utt_1', 'speechEnd', 1_000));
    // sttFirstPartial never arrives.
    const report = tracker.handleEnvelope(mark('utt_1', 'sttFinal', 1_600));

    expect(report?.stages).toEqual([{ stage: 'sttFinal', ms: 600 }]);
    expect(report?.stages.some((s) => Number.isNaN(s.ms))).toBe(false);
  });

  // TTS synthesizes each sentence while translation still streams, so ttsFirstByte
  // can precede mtFinal — which canonical-order diffing renders as a negative
  // "Synthesizing voice". Catches a return to canonical-order diffing.
  it('reports non-negative intervals when marks arrive out of canonical stage order', () => {
    const tracker = new CascadeLatencyTracker();
    tracker.handleEnvelope(mark('utt_1', 'speechEnd', 1_000));
    tracker.handleEnvelope(mark('utt_1', 'mtFirstToken', 1_500));
    tracker.handleEnvelope(mark('utt_1', 'ttsFirstByte', 1_800));
    // Translation finishes only after synthesis of the first sentence began.
    const report = tracker.handleEnvelope(mark('utt_1', 'mtFinal', 2_000));

    expect(report?.stages).toEqual([
      { stage: 'mtFirstToken', ms: 500 },
      { stage: 'ttsFirstByte', ms: 300 },
      { stage: 'mtFinal', ms: 200 },
    ]);
    expect(report?.stages.every((stage) => stage.ms >= 0)).toBe(true);
  });

  // Catches a crash/corruption bug: the very first mark an utterance ever
  // receives (whichever stage it happens to be) has nothing earlier to diff
  // against and must be omitted from `stages` entirely — never a `NaN` or a
  // delta against `undefined`.
  it('omits a stage from the breakdown when it is the first mark seen for its utterance, rather than reporting NaN', () => {
    const tracker = new CascadeLatencyTracker();
    // speechEnd itself dropped; sttFinal is the first mark this utterance ever gets.
    const report = tracker.handleEnvelope(mark('utt_1', 'sttFinal', 1_000));

    expect(report).toEqual({ utteranceId: 'utt_1', stages: [], endToEndMs: null });
  });

  // Catches a return to the server-span-plus-playback formula, which left both
  // network legs outside the number the benchmark reports.
  it('measures endToEndMs on the client clock, from learning speech ended to audio being audible', () => {
    let clientNow = 5_000;
    const tracker = new CascadeLatencyTracker({ now: () => clientNow });
    // Server stamps far from the client clock, so mixing them fails loudly.
    tracker.handleEnvelope(mark('utt_1', 'speechEnd', 1_700_000_000_000));
    clientNow = 5_400;
    tracker.handleEnvelope(mark('utt_1', 'ttsFirstByte', 1_700_000_000_800));
    const report = tracker.handleFirstChunkTiming({
      utteranceId: 'utt_1-target',
      clientReceiveToAudibleMs: 50,
      audibleAtMs: 5_900,
    });

    expect(report.endToEndMs).toBe(900);
  });

  // Catches a duplicate speechEnd re-opening the window and shortening every
  // measured latency.
  it('opens the window at the first speechEnd mark, not a later duplicate', () => {
    let clientNow = 1_000;
    const tracker = new CascadeLatencyTracker({ now: () => clientNow });
    tracker.handleEnvelope(mark('utt_1', 'speechEnd', 1_700_000_000_000));
    clientNow = 1_600;
    tracker.handleEnvelope(mark('utt_1', 'speechEnd', 1_700_000_000_000));
    const report = tracker.handleFirstChunkTiming({
      utteranceId: 'utt_1-target',
      clientReceiveToAudibleMs: 10,
      audibleAtMs: 2_000,
    });

    expect(report.endToEndMs).toBe(1_000);
  });

  // Catches the target/source utteranceId mismatch bug this adapter exists to bridge:
  // AudioPlaybackQueue reports TTS timing keyed by the *target*-lane id
  // (`${sourceId}-target`, per CascadePipeline.cs), while every latency.mark is keyed
  // by the un-suffixed source id. Without stripping the suffix, TTS timing would land
  // on a different report than the server-side marks and endToEndMs would never
  // resolve.
  it('resolves TTS playback timing against the same report as the source-lane marks, by stripping the "-target" suffix', () => {
    let clientNow = 1_000;
    const tracker = new CascadeLatencyTracker({ now: () => clientNow });
    tracker.handleEnvelope(mark('utt_1', 'speechEnd', 1_700_000_000_000));
    clientNow = 1_400;
    tracker.handleEnvelope(mark('utt_1', 'ttsFirstByte', 1_700_000_000_500));
    const report = tracker.handleFirstChunkTiming({
      utteranceId: 'utt_1-target',
      clientReceiveToAudibleMs: 20,
      audibleAtMs: 1_520,
    });

    expect(report.utteranceId).toBe('utt_1');
    expect(report.endToEndMs).toBe(520);
  });

  // Catches a stale-data bug: a tracker reused across sessions (mirroring how
  // CascadeInterpreterSession keeps one instance alive across start()/stop() cycles)
  // must not let a previous conversation's in-progress utterance bleed into a new
  // one's reports after reset().
  it('reset() clears every utterance accumulated so far', () => {
    const tracker = new CascadeLatencyTracker();
    tracker.handleEnvelope(mark('utt_1', 'speechEnd', 1_000));
    tracker.reset();
    const report = tracker.handleEnvelope(mark('utt_1', 'sttFinal', 1_000));

    // Since speechEnd was cleared by reset(), sttFinal is once again the first
    // mark seen for utt_1 and gets no delta — proof the old speechEnd mark didn't survive.
    expect(report).toEqual({ utteranceId: 'utt_1', stages: [], endToEndMs: null });
  });

  // Catches a crash/noise bug: envelopes this tracker doesn't care about (transcripts,
  // control frames, malformed frames) must be ignored rather than throwing or
  // fabricating a bogus report.
  it('returns null for non-latency-mark envelopes and malformed marks', () => {
    const tracker = new CascadeLatencyTracker();

    expect(tracker.handleEnvelope({ v: 1, type: 'session.ready', payload: {} })).toBeNull();
    expect(tracker.handleEnvelope(null)).toBeNull();
    expect(tracker.handleEnvelope({ v: 1, type: 'latency.mark', payload: { stage: 'speechEnd' } })).toBeNull();
    expect(
      tracker.handleEnvelope({ v: 1, type: 'latency.mark', payload: { utteranceId: 'u', stage: 'notAStage', serverTimeMs: 1 } }),
    ).toBeNull();
  });
});

describe('toSourceUtteranceId', () => {
  it('strips the "-target" suffix CascadePipeline appends for the target lane', () => {
    expect(toSourceUtteranceId('item_1-target')).toBe('item_1');
  });

  it('leaves an id with no "-target" suffix unchanged', () => {
    expect(toSourceUtteranceId('item_1')).toBe('item_1');
  });
});
