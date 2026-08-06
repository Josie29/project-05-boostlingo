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
  /** Local-clock moment the first audio became audible — the window's closing edge. */
  audibleAtMs: number;
}

/** Collaborators the tracker needs; swapped in tests for a deterministic clock. */
export interface CascadeLatencyTrackerDeps {
  /** The same local clock `AudioPlaybackQueue` stamps its timings with — real `performance.now()` in production. */
  now: () => number;
}

/** One utterance's accumulated raw marks/timing, not yet reduced into a display-ready {@link LatencyReport}. */
interface UtteranceLatencyState {
  /** `serverTimeMs` for every stage mark seen so far, keyed by stage name. */
  marks: Partial<Record<CascadeStage, number>>;
  /** Local-clock moment this client learned speech had ended — the window's opening edge. */
  clientSpeechEndAtMs: number | null;
  /** Local-clock moment this utterance's first audio became audible. */
  clientAudibleAtMs: number | null;
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
 * `endToEndMs` is the brief's perceived latency — speech end → first audio out
 * — measured end to end on the *client's* clock: from this client receiving the
 * `speechEnd` mark to its first audio actually becoming audible. Both readings
 * come from `deps.now()`, so it stays a same-clock subtraction, and unlike the
 * earlier server-span-plus-playback formula it leaves no leg uncounted: the
 * round trip a listener genuinely waits through is inside the number rather
 * than falling in the gap between a server stamp and a client one. The
 * server-clock stage marks still carry the breakdown; they attribute the time,
 * this measures it. `null` until both edges are known.
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

  const endToEndMs =
    state.clientSpeechEndAtMs !== null && state.clientAudibleAtMs !== null
      ? state.clientAudibleAtMs - state.clientSpeechEndAtMs
      : null;

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
  private readonly now: () => number;

  constructor(deps: CascadeLatencyTrackerDeps = { now: () => performance.now() }) {
    this.now = deps.now;
  }

  /** Clears every utterance accumulated so far, for a fresh session. */
  reset(): void {
    this.utterances.clear();
  }

  private getOrCreate(utteranceId: string): UtteranceLatencyState {
    let state = this.utterances.get(utteranceId);
    if (!state) {
      state = { marks: {}, clientSpeechEndAtMs: null, clientAudibleAtMs: null };
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
    // The speechEnd mark's *arrival* is the earliest this client can know speech
    // ended, so it opens the client-clock window. Its server timestamp still
    // anchors the stage breakdown; the two clocks stay unmixed.
    if (mark.stage === 'speechEnd' && state.clientSpeechEndAtMs === null) {
      state.clientSpeechEndAtMs = this.now();
    }
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
    state.clientAudibleAtMs = timing.audibleAtMs;
    return buildReport(utteranceId, state);
  }
}
