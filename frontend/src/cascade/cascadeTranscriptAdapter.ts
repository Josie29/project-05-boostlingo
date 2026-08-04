import type { TranscriptLane, TranscriptUpdate } from '../transcript/types';
import { CascadeMessageType, type CascadeTranscriptPayload, type CascadeTranscriptTruncatedPayload } from './types';

/**
 * Translates raw `{ v, type, payload }` envelopes off the cascade WebSocket
 * (see `backend/CascadeAudioSession.cs`) into the mode-agnostic
 * {@link TranscriptUpdate} shape the shared transcript reducer/panel
 * understand. Keeping this parsing here — instead of in the reducer or
 * `TranscriptPanel` — is what keeps those two transport-free, mirroring
 * `realtimeTranscriptAdapter`'s role for Realtime mode. No cascade wire type
 * (`CascadeMessageType`, `CascadeTranscriptPayload`) should be imported
 * outside this file.
 *
 * Partial/final semantics: `CascadePipeline` (`backend/CascadePipeline.cs`)
 * forwards `SttSegment.Text` verbatim onto `transcript.partial`/`.final`.
 * For `OpenAiSttProvider`, that's OpenAI's own `delta` field on a partial —
 * an incremental chunk, not the cumulative text-so-far (confirmed against
 * `backend/tests/OpenAiSttProviderTests.cs`, which asserts a `delta: "Hel"`
 * event yields a `"Hel"` segment, not a resend of everything heard so far)
 * — and the full `transcript` field on `.completed`/`transcript.final`. That
 * lines up exactly with the shared reducer's contract (`final: false` means
 * `text` is a delta to append; `final: true` means `text` is the complete,
 * replacing value), so this adapter is a direct field mapping with no extra
 * delta bookkeeping. If a future STT provider resends cumulative text on
 * partials instead, it would need to diff against the previous partial
 * here — the reducer never sees anything but the shared contract.
 */

/** Lanes this adapter accepts off the wire; anything else is dropped rather than fabricating a bogus column. */
const KNOWN_LANES: TranscriptLane[] = ['source', 'target'];

/** One parsed `{ v, type, payload }` frame off the cascade WebSocket, loosely typed pending validation below. */
interface CascadeEnvelopeShape {
  type?: unknown;
  payload?: unknown;
}

/** Narrows an unknown envelope's `payload` to the fields a transcript update needs, or `null` if any are missing/mistyped. */
function readTranscriptPayload(payload: unknown): CascadeTranscriptPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const candidate = payload as Partial<CascadeTranscriptPayload>;
  if (
    typeof candidate.utteranceId !== 'string' ||
    typeof candidate.lane !== 'string' ||
    typeof candidate.text !== 'string'
  ) {
    return null;
  }
  return {
    utteranceId: candidate.utteranceId,
    lane: candidate.lane,
    text: candidate.text,
    timestampMs: typeof candidate.timestampMs === 'number' ? candidate.timestampMs : 0,
  };
}

/** Narrows an unknown envelope's `payload` to the id a `transcript.truncated` update needs, or `null` if missing/mistyped. */
function readTruncatedPayload(payload: unknown): CascadeTranscriptTruncatedPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const candidate = payload as Partial<CascadeTranscriptTruncatedPayload>;
  return typeof candidate.utteranceId === 'string' ? { utteranceId: candidate.utteranceId } : null;
}

/**
 * Maps one raw cascade WebSocket envelope (already JSON-parsed) to a
 * {@link TranscriptUpdate}, or `null` if the envelope isn't a transcript
 * event (`session.ready`/`error`/etc.), carries an unrecognized `lane`, or
 * is missing the fields needed to place it.
 *
 * `transcript.truncated` (issue #11) is handled separately from
 * `.partial`/`.final`: its payload carries only an id, always the
 * *target*-lane one (the same id space `tts.audio.start`/`.end` use — see
 * {@link CascadeTranscriptTruncatedPayload}), so the resulting update is
 * always `lane: 'target'` and carries `truncated: true`. `text`/`final` are
 * filled in for {@link TranscriptUpdate}'s shape but are never read by the
 * reducer for a truncated update — see `transcriptReducer.ts`.
 */
export function mapCascadeEventToTranscriptUpdate(rawEvent: unknown): TranscriptUpdate | null {
  if (typeof rawEvent !== 'object' || rawEvent === null) return null;
  const envelope = rawEvent as CascadeEnvelopeShape;

  if (envelope.type === CascadeMessageType.TranscriptTruncated) {
    const truncatedPayload = readTruncatedPayload(envelope.payload);
    if (!truncatedPayload) return null;
    return { utteranceId: truncatedPayload.utteranceId, lane: 'target', text: '', final: true, truncated: true };
  }

  const isPartial = envelope.type === CascadeMessageType.TranscriptPartial;
  const isFinal = envelope.type === CascadeMessageType.TranscriptFinal;
  if (!isPartial && !isFinal) return null;

  const payload = readTranscriptPayload(envelope.payload);
  if (!payload) return null;
  if (!KNOWN_LANES.includes(payload.lane as TranscriptLane)) return null;

  return {
    utteranceId: payload.utteranceId,
    lane: payload.lane as TranscriptLane,
    text: payload.text,
    final: isFinal,
  };
}
