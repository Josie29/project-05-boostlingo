import { CASCADE_STAGE_ORDER } from './cascadeStages';

/**
 * Presentation-only naming for latency stages. The UI-facing latency domain
 * treats stage names as opaque strings (see `cascadeStages.ts`); this module is
 * the one place that assigns them human wording, and every lookup falls back to
 * the raw name so an unrecognized stage degrades to something readable rather
 * than disappearing.
 *
 * Labels name the *work in the interval*, not a moment: each stage's `ms` is the
 * delta from the preceding mark (`cascadeLatencyAdapter.buildReport`), so
 * "Recognizing speech: 184ms" is the honest reading of the number.
 */
/**
 * Whether a stage falls inside the brief's perceived-latency window — speech end
 * → first audio out (`docs/BRIEF.md`). Everything up to first audio is time the
 * listener spends waiting; anything after it elapses while they're already
 * hearing the interpretation, so it must never be added to a latency figure.
 */
export const StageScope = {
  Perceived: 'perceived',
  AfterFirstAudio: 'afterFirstAudio',
} as const;

export type StageScope = (typeof StageScope)[keyof typeof StageScope];

interface StageCopy {
  label: string;
  /**
   * What the mark ending this interval means — surfaced as the row's tooltip.
   * Deliberately names only the *end* of the span: a stage's duration is measured
   * from whichever mark chronologically preceded it, and marks go missing (a
   * short utterance with no STT partial, a provider that emits no first-token
   * event), so naming a fixed predecessor would state something untrue on those
   * utterances. Stored data shows this is routine, not theoretical — sttFinal has
   * more samples than sttFirstPartial.
   */
  span: string;
  scope: StageScope;
}

const STAGE_COPY: Record<string, StageCopy> = {
  // Cascade marks (`CASCADE_STAGE_ORDER`).
  speechEnd: {
    label: 'Speech ends',
    span: 'the VAD committed the turn — the anchor every later span is measured from',
    scope: StageScope.Perceived,
  },
  sttFirstPartial: {
    label: 'Recognizing speech',
    span: 'ends when the first words come back from speech-to-text',
    scope: StageScope.Perceived,
  },
  sttFinal: {
    label: 'Finalizing transcript',
    span: 'ends when the transcript settles',
    scope: StageScope.Perceived,
  },
  mtFirstToken: {
    label: 'Starting translation',
    span: 'ends at the first translated word',
    scope: StageScope.Perceived,
  },
  mtFinal: {
    label: 'Finishing translation',
    span: 'ends when translation completes — voice synthesis may already be running',
    scope: StageScope.Perceived,
  },
  ttsFirstByte: {
    label: 'Generating voice',
    span: 'ends at the first synthesized audio byte — the perceived-latency finish line',
    scope: StageScope.Perceived,
  },
  ttsEnd: {
    label: 'Audio plays out',
    span: 'ends when the audio finishes — elapses while the listener is already hearing it',
    scope: StageScope.AfterFirstAudio,
  },
  // Realtime stages (`realtimeLatencyAdapter`) — one model, so no STT/MT/TTS split.
  // Both land inside the window: together they are exactly the perceived latency.
  responseCreated: {
    label: 'Model responds',
    span: 'ends when the model starts its turn',
    scope: StageScope.Perceived,
  },
  audioStart: {
    label: 'Generating voice',
    span: 'ends when the first audio arrives — the perceived-latency finish line',
    scope: StageScope.Perceived,
  },
};

/**
 * Display order across both modes. Cascade comes from the protocol constant so
 * the two can't drift; realtime's two stages follow. A mode's stages are never
 * listed together, so the concatenation only ever orders one mode at a time.
 */
const DISPLAY_ORDER: readonly string[] = [...CASCADE_STAGE_ORDER, 'responseCreated', 'audioStart'];

/** Human wording for a stage, or the raw name if it isn't one we have copy for. */
export function stageLabel(stage: string): string {
  return STAGE_COPY[stage]?.label ?? stage;
}

/** Tooltip describing which two marks the duration spans, or `undefined` for an unknown stage. */
export function stageSpan(stage: string): string | undefined {
  return STAGE_COPY[stage]?.span;
}

/**
 * Whether a stage counts toward perceived latency. An unrecognized stage is
 * treated as perceived — the same default every known stage but `ttsEnd` has, and
 * the one that keeps a new mark visible in the breakdown rather than hidden in
 * the after-the-fact footnote.
 */
export function stageScope(stage: string): StageScope {
  return STAGE_COPY[stage]?.scope ?? StageScope.Perceived;
}

/**
 * Orders stages the way the pipeline runs them rather than alphabetically (the
 * backend's summary sorts stage keys ordinally). Unknown stages sort after all
 * known ones, alphabetically among themselves, so wire drift lands in a stable
 * spot instead of mid-pipeline.
 */
export function compareStages(a: string, b: string): number {
  const indexA = DISPLAY_ORDER.indexOf(a);
  const indexB = DISPLAY_ORDER.indexOf(b);
  if (indexA === -1 && indexB === -1) return a.localeCompare(b);
  if (indexA === -1) return 1;
  if (indexB === -1) return -1;
  return indexA - indexB;
}
