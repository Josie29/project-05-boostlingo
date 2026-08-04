import { describe, expect, it } from 'vitest';
import { mapRealtimeEventToTranscriptUpdate } from '../realtime/realtimeTranscriptAdapter';

describe('mapRealtimeEventToTranscriptUpdate', () => {
  // Catches the bug where what the caller actually said never reaches the transcript
  // panel's source column because the input-transcription delta event was never parsed.
  it('maps an input audio transcription delta to a source-lane partial update', () => {
    const update = mapRealtimeEventToTranscriptUpdate({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item_1',
      delta: 'Hola',
    });

    expect(update).toEqual({ utteranceId: 'item_1', lane: 'source', text: 'Hola', final: false });
  });

  // Catches the bug where the source utterance never settles into its final,
  // "done talking" styling because the completed event wasn't recognized.
  it('maps an input audio transcription completed event to a final source update', () => {
    const update = mapRealtimeEventToTranscriptUpdate({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_1',
      transcript: 'Hola, ¿cómo estás?',
    });

    expect(update).toEqual({
      utteranceId: 'item_1',
      lane: 'source',
      text: 'Hola, ¿cómo estás?',
      final: true,
    });
  });

  // Catches the bug where the model's own spoken interpretation never reaches the
  // target column because the output transcript delta event was never parsed.
  it('maps a response output audio transcript delta to a target-lane partial update', () => {
    const update = mapRealtimeEventToTranscriptUpdate({
      type: 'response.output_audio_transcript.delta',
      item_id: 'item_2',
      delta: 'Hello',
    });

    expect(update).toEqual({ utteranceId: 'item_2', lane: 'target', text: 'Hello', final: false });
  });

  it('maps a response output audio transcript done event to a final target update', () => {
    const update = mapRealtimeEventToTranscriptUpdate({
      type: 'response.output_audio_transcript.done',
      item_id: 'item_2',
      transcript: 'Hello, how are you?',
    });

    expect(update).toEqual({
      utteranceId: 'item_2',
      lane: 'target',
      text: 'Hello, how are you?',
      final: true,
    });
  });

  // Catches a model/API-version regression: earlier Realtime previews name this event
  // `response.audio_transcript.*` (no "output_"). Accepting both means a version drift
  // silently drops the target lane instead of requiring a code change to notice.
  it('also accepts the older response.audio_transcript.* event names', () => {
    const delta = mapRealtimeEventToTranscriptUpdate({
      type: 'response.audio_transcript.delta',
      item_id: 'item_3',
      delta: 'Bonjour',
    });
    const done = mapRealtimeEventToTranscriptUpdate({
      type: 'response.audio_transcript.done',
      item_id: 'item_3',
      transcript: 'Bonjour tout le monde',
    });

    expect(delta).toEqual({ utteranceId: 'item_3', lane: 'target', text: 'Bonjour', final: false });
    expect(done).toEqual({
      utteranceId: 'item_3',
      lane: 'target',
      text: 'Bonjour tout le monde',
      final: true,
    });
  });

  // Catches a crash/noise bug: the data channel carries many non-transcript events
  // (session lifecycle, function calls, audio buffer acks, etc.); the adapter must
  // silently ignore them rather than throwing or fabricating a bogus update.
  it('returns null for unrelated event types', () => {
    expect(mapRealtimeEventToTranscriptUpdate({ type: 'session.updated' })).toBeNull();
    expect(mapRealtimeEventToTranscriptUpdate({ type: 'response.done' })).toBeNull();
  });

  // Catches a crash bug: malformed/partial events (missing fields, non-JSON-object
  // payloads) must be dropped instead of throwing and taking down the event pipeline.
  it('returns null for malformed events instead of throwing', () => {
    expect(mapRealtimeEventToTranscriptUpdate(null)).toBeNull();
    expect(mapRealtimeEventToTranscriptUpdate('not an object')).toBeNull();
    expect(
      mapRealtimeEventToTranscriptUpdate({ type: 'conversation.item.input_audio_transcription.delta' }),
    ).toBeNull();
  });
});
