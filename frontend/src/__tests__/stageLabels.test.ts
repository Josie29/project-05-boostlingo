import { describe, expect, it } from 'vitest';
import { compareStages, stageLabel, stageScope, StageScope, stageSpan } from '../latency/stageLabels';

describe('stageLabels', () => {
  // The backend serves stage stats sorted ordinally, which reads backwards
  // through the pipeline (mtFinal before sttFinal). Catches the breakdown
  // reverting to alphabetical order.
  it('orders stages the way the pipeline runs them, not alphabetically', () => {
    const sorted = ['ttsEnd', 'mtFinal', 'sttFirstPartial', 'ttsFirstByte', 'mtFirstToken', 'sttFinal'].sort(
      compareStages,
    );

    expect(sorted).toEqual(['sttFirstPartial', 'sttFinal', 'mtFirstToken', 'mtFinal', 'ttsFirstByte', 'ttsEnd']);
  });

  // The brief defines latency as speech end → first audio out, so ttsEnd (audio
  // playing out, after the listener already hears it) must never be presented as
  // part of that number. Catches it being folded back into the breakdown.
  it('scopes only spans up to first audio out as perceived latency', () => {
    expect(stageScope('ttsFirstByte')).toBe(StageScope.Perceived);
    expect(stageScope('audioStart')).toBe(StageScope.Perceived);
    expect(stageScope('ttsEnd')).toBe(StageScope.AfterFirstAudio);
  });

  // Catches a future backend stage vanishing from the breakdown (or landing
  // mid-pipeline) because the UI has no copy for it yet.
  it('falls back to the raw name and sorts unknown stages last', () => {
    expect(stageLabel('vadWarmup')).toBe('vadWarmup');
    expect(stageSpan('vadWarmup')).toBeUndefined();
    expect(['vadWarmup', 'sttFinal'].sort(compareStages)).toEqual(['sttFinal', 'vadWarmup']);
  });
});
