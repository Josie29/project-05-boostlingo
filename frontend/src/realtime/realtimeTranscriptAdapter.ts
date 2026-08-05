import type { TranscriptUpdate } from '../transcript/types';

/**
 * Translates raw events off the Realtime session's `oai-events` data
 * channel into the mode-agnostic {@link TranscriptUpdate} shape the shared
 * transcript reducer/panel understand. Keeping this parsing here — instead
 * of in the reducer or `TranscriptPanel` — is what keeps those two
 * Realtime-free, so the cascade pipeline can feed them from its own adapter
 * (`cascadeTranscriptAdapter.ts`) without either shared piece knowing
 * OpenAI's wire format exists.
 *
 * Event names/fields follow OpenAI's Realtime API for `gpt-realtime`
 * sessions. The `response.audio_transcript.*` variants (singular, no
 * "output_") are also accepted since earlier preview models used that
 * naming — accepting both means a model/API version drift silently drops
 * transcripts rather than requiring a code change to notice.
 */

type InputTranscriptionEventType =
  | 'conversation.item.input_audio_transcription.delta'
  | 'conversation.item.input_audio_transcription.completed';

type OutputTranscriptEventType =
  | 'response.output_audio_transcript.delta'
  | 'response.output_audio_transcript.done'
  | 'response.audio_transcript.delta'
  | 'response.audio_transcript.done';

/** The event's `item_id` doubles as the transcript panel's per-utterance grouping id. */
interface TranscriptionEventShape {
  item_id?: unknown;
  delta?: unknown;
  transcript?: unknown;
}

/** Narrows an unknown data-channel payload to "has a string `type`", the only thing checked before dispatch. */
function readEventType(rawEvent: unknown): string | null {
  if (typeof rawEvent !== 'object' || rawEvent === null) return null;
  const type = (rawEvent as { type?: unknown }).type;
  return typeof type === 'string' ? type : null;
}

/** Builds an update from a partial (delta) transcription event, or `null` if required fields are missing. */
function fromDelta(rawEvent: TranscriptionEventShape, lane: TranscriptUpdate['lane']): TranscriptUpdate | null {
  if (typeof rawEvent.item_id !== 'string' || typeof rawEvent.delta !== 'string') return null;
  return { utteranceId: rawEvent.item_id, lane, text: rawEvent.delta, final: false };
}

/** Builds an update from a completed/done (final) transcription event, or `null` if required fields are missing. */
function fromCompleted(rawEvent: TranscriptionEventShape, lane: TranscriptUpdate['lane']): TranscriptUpdate | null {
  if (typeof rawEvent.item_id !== 'string' || typeof rawEvent.transcript !== 'string') return null;
  return { utteranceId: rawEvent.item_id, lane, text: rawEvent.transcript, final: true };
}

/**
 * Maps one raw Realtime data-channel event (already JSON-parsed) to a
 * {@link TranscriptUpdate}, or `null` if the event isn't transcript-related
 * (session lifecycle, function calls, audio-only frames, etc.) or is
 * missing the fields needed to place it.
 */
export function mapRealtimeEventToTranscriptUpdate(rawEvent: unknown): TranscriptUpdate | null {
  const type = readEventType(rawEvent);
  if (type === null) return null;
  const event = rawEvent as TranscriptionEventShape;

  switch (type as InputTranscriptionEventType | OutputTranscriptEventType) {
    case 'conversation.item.input_audio_transcription.delta':
      return fromDelta(event, 'source');
    case 'conversation.item.input_audio_transcription.completed':
      return fromCompleted(event, 'source');
    case 'response.output_audio_transcript.delta':
    case 'response.audio_transcript.delta':
      return fromDelta(event, 'target');
    case 'response.output_audio_transcript.done':
    case 'response.audio_transcript.done':
      return fromCompleted(event, 'target');
    default:
      return null;
  }
}
