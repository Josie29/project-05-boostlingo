import { describe, expect, it } from 'vitest';
import { compareStages, stageFamily, stageLabel, stageScope, StageScope, stageSpan } from '../latency/stageLabels';

describe('stageLabels', () => {
  // The backend sorts stage keys ordinally, which reads backwards through the
  // pipeline. Catches the breakdown reverting to that order.
  it('orders stages the way the pipeline runs them, not alphabetically', () => {
    const sorted = [
      'ttsEnd',
      'mtFinal',
      'sttFirstPartial',
      'ttsFirstByte',
      'ttsRequestSent',
      'mtFirstToken',
      'sttFinal',
    ].sort(compareStages);

    expect(sorted).toEqual([
      'sttFirstPartial',
      'sttFinal',
      'mtFirstToken',
      'mtFinal',
      'ttsRequestSent',
      'ttsFirstByte',
      'ttsEnd',
    ]);
  });

  // The dispatch half of the TTS span is still our own code's time, and it still
  // happens before the listener hears anything. Catches it being scoped out of
  // perceived latency (which would hide it from the headline number) or colored
  // as a non-TTS subsystem.
  it('counts the TTS dispatch span as perceived latency, in the voice family', () => {
    expect(stageScope('ttsRequestSent')).toBe(StageScope.Perceived);
    expect(stageFamily('ttsRequestSent')).toBe('tts');
  });

  // ttsEnd elapses after the listener already hears the audio. Catches it being
  // folded back into the latency breakdown.
  it('scopes only spans up to first audio out as perceived latency', () => {
    expect(stageScope('ttsFirstByte')).toBe(StageScope.Perceived);
    expect(stageScope('audioStart')).toBe(StageScope.Perceived);
    expect(stageScope('ttsEnd')).toBe(StageScope.AfterFirstAudio);
  });

  // Catches a future backend stage vanishing (or landing mid-pipeline) because
  // the UI has no copy for it yet.
  it('falls back to the raw name and sorts unknown stages last', () => {
    expect(stageLabel('vadWarmup')).toBe('vadWarmup');
    expect(stageSpan('vadWarmup')).toBeUndefined();
    expect(['vadWarmup', 'sttFinal'].sort(compareStages)).toEqual(['sttFinal', 'vadWarmup']);
  });
});
