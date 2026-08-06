import { CASCADE_STAGE_ORDER } from './cascadeStages';

/**
 * Presentation-only naming for latency stages — the one place stage names get
 * human wording, so the latency domain itself can keep treating them as opaque
 * strings (`cascadeStages.ts`). Every lookup falls back to the raw name.
 *
 * Labels name the *work in the interval*, not a moment: each stage's `ms` is a
 * delta from the preceding mark, so "Recognizing speech: 184ms" reads true.
 */
/**
 * Whether a stage falls inside the brief's perceived-latency window — speech end
 * → first audio out. Anything after it elapses while the listener is already
 * hearing the interpretation, so it can never be part of a latency figure.
 */
export const StageScope = {
  Perceived: 'perceived',
  AfterFirstAudio: 'afterFirstAudio',
} as const;

export type StageScope = (typeof StageScope)[keyof typeof StageScope];

/** Pipeline subsystem a stage belongs to; `other` covers derived rows and unknown marks. */
export type StageFamily = 'stt' | 'mt' | 'tts' | 'other';

interface StageCopy {
  label: string;
  /**
   * Tooltip naming only where the interval *ends*: it is measured from whichever
   * mark actually preceded it, and marks go missing routinely, so naming a fixed
   * predecessor would be untrue on those utterances.
   */
  span: string;
  scope: StageScope;
}

const STAGE_COPY: Record<string, StageCopy> = {
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
    label: 'Synthesizing voice',
    span: 'ends at the first synthesized audio byte — the perceived-latency finish line',
    scope: StageScope.Perceived,
  },
  ttsEnd: {
    label: 'Audio plays out',
    span: 'ends when the audio finishes — elapses while the listener is already hearing it',
    scope: StageScope.AfterFirstAudio,
  },
  // Realtime (`realtimeLatencyAdapter`): one model, and the two together are
  // exactly the perceived latency.
  responseCreated: {
    label: 'Model responds',
    span: 'ends when the model starts its turn',
    scope: StageScope.Perceived,
  },
  audioStart: {
    label: 'Synthesizing voice',
    span: 'ends when the first audio arrives — the perceived-latency finish line',
    scope: StageScope.Perceived,
  },
};

/** Cascade order comes from the protocol constant so the two can't drift; a list only ever holds one mode's stages. */
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
 * Which pipeline subsystem a stage belongs to — the bar's color. Realtime's
 * stages map onto the same three: one model does the work, but the listener is
 * still waiting on recognition, then on speech.
 */
export function stageFamily(stage: string): StageFamily {
  if (stage.startsWith('stt') || stage === 'speechEnd' || stage === 'responseCreated') return 'stt';
  if (stage.startsWith('mt')) return 'mt';
  if (stage.startsWith('tts') || stage === 'audioStart') return 'tts';
  return 'other';
}

/** Whether a stage counts toward perceived latency; unknown stages default to perceived, keeping a new mark visible. */
export function stageScope(stage: string): StageScope {
  return STAGE_COPY[stage]?.scope ?? StageScope.Perceived;
}

/**
 * Pipeline order, not the ordinal order the backend's summary returns. Unknown
 * stages sort last so wire drift can't land mid-pipeline.
 */
export function compareStages(a: string, b: string): number {
  const indexA = DISPLAY_ORDER.indexOf(a);
  const indexB = DISPLAY_ORDER.indexOf(b);
  if (indexA === -1 && indexB === -1) return a.localeCompare(b);
  if (indexA === -1) return 1;
  if (indexB === -1) return -1;
  return indexA - indexB;
}
