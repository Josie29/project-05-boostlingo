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
interface StageCopy {
  label: string;
  /** Which two marks the duration spans — surfaced as the row's tooltip. */
  span: string;
}

const STAGE_COPY: Record<string, StageCopy> = {
  // Cascade marks (`CASCADE_STAGE_ORDER`).
  speechEnd: { label: 'Speech ends', span: 'the anchor every later span is measured from' },
  sttFirstPartial: { label: 'Recognizing speech', span: 'end of speech → first words back' },
  sttFinal: { label: 'Finalizing transcript', span: 'first words → settled transcript' },
  mtFirstToken: { label: 'Starting translation', span: 'settled transcript → first translated word' },
  mtFinal: { label: 'Finishing translation', span: 'first translated word → translation complete' },
  ttsFirstByte: { label: 'Generating voice', span: 'translation → first audio byte' },
  ttsEnd: { label: 'Speaking', span: 'first audio byte → audio finished' },
  // Realtime stages (`realtimeLatencyAdapter`) — one model, so no STT/MT/TTS split.
  responseCreated: { label: 'Model responds', span: 'end of speech → model starts its turn' },
  audioStart: { label: 'Speaking', span: 'model starts its turn → first audio out' },
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
