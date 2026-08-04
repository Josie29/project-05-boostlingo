import { describe, expect, it } from 'vitest';
import { mapCascadeEventToTranscriptUpdate } from '../cascade/cascadeTranscriptAdapter';

describe('mapCascadeEventToTranscriptUpdate', () => {
  // Catches the bug where what the caller actually said never reaches the transcript
  // panel's source column because a transcript.partial envelope was never parsed.
  it('maps a transcript.partial envelope to a source-lane, non-final update', () => {
    const update = mapCascadeEventToTranscriptUpdate({
      v: 1,
      type: 'transcript.partial',
      payload: { utteranceId: 'utt_1', lane: 'source', text: 'Hel', timestampMs: 120 },
    });

    expect(update).toEqual({ utteranceId: 'utt_1', lane: 'source', text: 'Hel', final: false });
  });

  // Catches the bug where the source utterance never settles into its final, "done
  // talking" styling because the transcript.final envelope wasn't recognized.
  it('maps a transcript.final envelope to a final source update', () => {
    const update = mapCascadeEventToTranscriptUpdate({
      v: 1,
      type: 'transcript.final',
      payload: { utteranceId: 'utt_1', lane: 'source', text: 'Hello there', timestampMs: 480 },
    });

    expect(update).toEqual({ utteranceId: 'utt_1', lane: 'source', text: 'Hello there', final: true });
  });

  // Catches the subtle bug this issue is centrally about: the backend's
  // transcript.partial carries a delta chunk (confirmed against
  // backend/tests/OpenAiSttProviderTests.cs, which asserts a `delta: "Hel"` event
  // yields a "Hel" segment, not the full text heard so far). The adapter must pass
  // that delta straight through rather than treating it as the utterance's complete
  // text so far — otherwise feeding it to the shared reducer (which appends on
  // non-final updates) would double up text on every subsequent partial.
  it('passes consecutive partials straight through as deltas, matching the reducer append contract', () => {
    const first = mapCascadeEventToTranscriptUpdate({
      v: 1,
      type: 'transcript.partial',
      payload: { utteranceId: 'utt_2', lane: 'source', text: 'Hel', timestampMs: 100 },
    });
    const second = mapCascadeEventToTranscriptUpdate({
      v: 1,
      type: 'transcript.partial',
      payload: { utteranceId: 'utt_2', lane: 'source', text: 'lo', timestampMs: 150 },
    });

    // Each update carries exactly the chunk from its own envelope — no accumulation,
    // no re-emission of prior text — so the reducer's `existing.text + update.text`
    // append produces "Hello" rather than "HelHello" or some other doubled-up result.
    expect(first).toEqual({ utteranceId: 'utt_2', lane: 'source', text: 'Hel', final: false });
    expect(second).toEqual({ utteranceId: 'utt_2', lane: 'source', text: 'lo', final: false });
  });

  // Catches a crash/noise bug: the cascade socket carries session.ready/error control
  // frames too; the adapter must silently ignore them rather than throwing or
  // fabricating a bogus transcript entry.
  it('returns null for non-transcript envelope types', () => {
    expect(mapCascadeEventToTranscriptUpdate({ v: 1, type: 'session.ready', payload: {} })).toBeNull();
    expect(mapCascadeEventToTranscriptUpdate({ v: 1, type: 'error', payload: { message: 'boom' } })).toBeNull();
  });

  // Catches a crash bug: malformed/partial envelopes (missing fields, non-object
  // payloads, non-JSON-object events) must be dropped instead of throwing and taking
  // down the event pipeline.
  it('returns null for malformed envelopes instead of throwing', () => {
    expect(mapCascadeEventToTranscriptUpdate(null)).toBeNull();
    expect(mapCascadeEventToTranscriptUpdate('not an object')).toBeNull();
    expect(mapCascadeEventToTranscriptUpdate({ v: 1, type: 'transcript.partial' })).toBeNull();
    expect(
      mapCascadeEventToTranscriptUpdate({ v: 1, type: 'transcript.partial', payload: { lane: 'source', text: 'Hi' } }),
    ).toBeNull();
  });

  // Catches a bug where an unrecognized lane (e.g. a future stage's typo, or wire
  // drift) silently creates a bogus third transcript column instead of being dropped.
  it('returns null when the payload lane is not a recognized lane', () => {
    expect(
      mapCascadeEventToTranscriptUpdate({
        v: 1,
        type: 'transcript.partial',
        payload: { utteranceId: 'utt_3', lane: 'unknown-lane', text: 'Hi', timestampMs: 0 },
      }),
    ).toBeNull();
  });
});
