import { CascadeMessageType } from '../cascade/types';
import { CASCADE_STAGE_ORDER, isCascadeStage, type CascadeStage } from './cascadeStages';
import type { LatencyReport, LatencyStageTiming } from './types';

/**
 * Suffix `CascadePipeline` appends to mint the target-lane utteranceId
 * (`backend/CascadePipeline.cs`: `targetUtteranceId = $"{segment.UtteranceId}-target"`)
 * that `transcript.*`/`tts.audio.*` envelopes for the *translated* side use.
 * Every `latency.mark` (#10), by contrast, is always keyed by the
 * un-suffixed source-lane id (see `CascadeLatencyStages`' remarks in
 * `backend/CascadeAudioSession.cs`) — including the TTS-stage marks
 * (`ttsFirstByte`/`ttsEnd`), which are emitted against
 * `TranslationChunk.SourceUtteranceId`, not the `TargetUtteranceId` that
 * `tts.audio.start`/`tts.audio.end` (and therefore `CascadeAudioEvent`,
 * `AudioPlaybackQueue`'s first-chunk timing) use.
 */
const TARGET_SUFFIX = '-target';

/**
 * Maps a target-lane utteranceId (as seen on `CascadeAudioEvent`) back to
 * the source-lane id every `latency.mark` for the same utterance shares, so
 * TTS playback timing can be folded into the same report as the server-side
 * marks. An id with no `-target` suffix is returned unchanged (defensive;
 * every id `AudioPlaybackQueue` reports here should have one).
 */
export function toSourceUtteranceId(utteranceId: string): string {
  return utteranceId.endsWith(TARGET_SUFFIX) ? utteranceId.slice(0, -TARGET_SUFFIX.length) : utteranceId;
}

/** One TTS-chunk timing sample handed off by `AudioPlaybackQueue.subscribeToFirstChunkTiming`. */
export interface FirstChunkTiming {
  utteranceId: string;
  clientReceiveToAudibleMs: number;
}

/** One utterance's accumulated raw marks/timing, not yet reduced into a display-ready {@link LatencyReport}. */
interface UtteranceLatencyState {
  /** `serverTimeMs` for every stage mark seen so far, keyed by stage name. */
  marks: Partial<Record<CascadeStage, number>>;
  /** Local client-only span from first-TTS-chunk receipt to its scheduled audible time, ms — set at most once per utterance. Never mixed with a server timestamp. */
  clientReceiveToAudibleMs: number | null;
}

/** The wire shape of a `latency.mark` envelope's payload, loosely typed pending validation. */
interface LatencyMarkPayloadShape {
  utteranceId?: unknown;
  stage?: unknown;
  serverTimeMs?: unknown;
}

/** Narrows an unknown, already-JSON-parsed cascade envelope to a validated `latency.mark`, or `null` if it isn't one (or is malformed). */
function readLatencyMark(rawEvent: unknown): { utteranceId: string; stage: CascadeStage; serverTimeMs: number } | null {
  if (typeof rawEvent !== 'object' || rawEvent === null) return null;
  const envelope = rawEvent as { type?: unknown; payload?: unknown };
  if (envelope.type !== CascadeMessageType.LatencyMark) return null;
  if (typeof envelope.payload !== 'object' || envelope.payload === null) return null;

  const payload = envelope.payload as LatencyMarkPayloadShape;
  if (
    typeof payload.utteranceId !== 'string' ||
    typeof payload.stage !== 'string' ||
    typeof payload.serverTimeMs !== 'number' ||
    !isCascadeStage(payload.stage)
  ) {
    return null;
  }

  return { utteranceId: payload.utteranceId, stage: payload.stage, serverTimeMs: payload.serverTimeMs };
}

/**
 * Reduces one utterance's accumulated marks/timing into a {@link LatencyReport}.
 *
 * Per-stage `ms` is the delta between one stage's `serverTimeMs` and the
 * chronologically preceding mark this utterance has — a server-clock-only
 * subtraction, never a client-minus-server one. A stage with no earlier mark to
 * diff against (including the very first mark this utterance has, whichever
 * stage that happens to be) is simply omitted from `stages` rather than
 * reported as a zero or `NaN` placeholder, so a dropped/late mark degrades the
 * breakdown gracefully instead of corrupting it. A stage's `ms` is therefore
 * "the interval that ended at this mark", whichever mark opened it — not
 * necessarily the canonical predecessor, which may be missing or later.
 *
 * `endToEndMs` is `ttsFirstByte - speechEnd` (both server clock — the
 * server-relative span issue #10 specifies) plus the local
 * `clientReceiveToAudibleMs` span (client receipt of that first audio frame
 * to its actually-scheduled/audible time) — two same-clock differences
 * summed, per the clock-discipline the issue calls out, never `null - null`
 * or a partial cross-clock guess. `null` until both halves are known.
 */
function buildReport(utteranceId: string, state: UtteranceLatencyState): LatencyReport {
  const stages: LatencyStageTiming[] = [];
  let previousMarkMs: number | null = null;

  // Chronological, not `CASCADE_STAGE_ORDER`: the pipeline overlaps. TTS
  // synthesizes each sentence as translation streams (`TtsCascadeObserver`
  // calls `SynthesizePhraseAsync` from the chunker on non-final chunks), so a
  // multi-sentence utterance can produce ttsFirstByte before mtFinal. Diffing
  // in canonical order would then report a negative duration; diffing in
  // timestamp order always yields a real, non-negative interval ending at that
  // mark. Ties break on canonical order so same-millisecond marks stay readable.
  const marked = CASCADE_STAGE_ORDER.map((stage, index) => ({ stage, index, markMs: state.marks[stage] }))
    .filter((entry): entry is { stage: CascadeStage; index: number; markMs: number } => entry.markMs !== undefined)
    .sort((a, b) => a.markMs - b.markMs || a.index - b.index);

  for (const { stage, markMs } of marked) {
    if (previousMarkMs !== null) {
      stages.push({ stage, ms: markMs - previousMarkMs });
    }
    previousMarkMs = markMs;
  }

  const speechEndMs = state.marks.speechEnd;
  const ttsFirstByteMs = state.marks.ttsFirstByte;
  const serverSpanMs = speechEndMs !== undefined && ttsFirstByteMs !== undefined ? ttsFirstByteMs - speechEndMs : null;
  const endToEndMs =
    serverSpanMs !== null && state.clientReceiveToAudibleMs !== null ? serverSpanMs + state.clientReceiveToAudibleMs : null;

  return { utteranceId, stages, endToEndMs };
}

/**
 * Accumulates cascade `latency.mark` envelopes (issue #10) and local TTS
 * playback timing into one {@link LatencyReport} per utterance, keyed by the
 * source-lane utteranceId every mark for that utterance shares.
 *
 * One instance is meant to live for a single session's duration —
 * `CascadeInterpreterSession` calls {@link reset} on every `start()` so a
 * new conversation doesn't inherit a previous one's in-progress utterances.
 */
export class CascadeLatencyTracker {
  private readonly utterances = new Map<string, UtteranceLatencyState>();

  /** Clears every utterance accumulated so far, for a fresh session. */
  reset(): void {
    this.utterances.clear();
  }

  private getOrCreate(utteranceId: string): UtteranceLatencyState {
    let state = this.utterances.get(utteranceId);
    if (!state) {
      state = { marks: {}, clientReceiveToAudibleMs: null };
      this.utterances.set(utteranceId, state);
    }
    return state;
  }

  /**
   * Feeds one raw `{ v, type, payload }` cascade envelope. Returns the
   * utterance's updated report, or `null` if this envelope wasn't a
   * `latency.mark` (every other envelope type — transcripts, TTS audio
   * windows, control frames — is silently ignored here; other adapters
   * handle those).
   */
  handleEnvelope(rawEvent: unknown): LatencyReport | null {
    const mark = readLatencyMark(rawEvent);
    if (!mark) return null;

    const state = this.getOrCreate(mark.utteranceId);
    state.marks[mark.stage] = mark.serverTimeMs;
    return buildReport(mark.utteranceId, state);
  }

  /**
   * Feeds one TTS-playback timing sample, keyed by the *target*-lane
   * utteranceId `AudioPlaybackQueue` reports (translated via
   * {@link toSourceUtteranceId} before being stored). Returns the
   * utterance's updated report.
   */
  handleFirstChunkTiming(timing: FirstChunkTiming): LatencyReport {
    const utteranceId = toSourceUtteranceId(timing.utteranceId);
    const state = this.getOrCreate(utteranceId);
    state.clientReceiveToAudibleMs = timing.clientReceiveToAudibleMs;
    return buildReport(utteranceId, state);
  }
}
