import { describe, expect, it } from 'vitest';
import { latencyReducer, selectLatencyAverages, selectRecentReports } from '../latency/latencyReducer';
import { INITIAL_LATENCY_STATE } from '../latency/types';
import type { LatencyReport } from '../latency/types';

function report(overrides: Partial<LatencyReport> = {}): LatencyReport {
  return { utteranceId: 'utt_1', stages: [], endToEndMs: null, ...overrides };
}

describe('latencyReducer', () => {
  // Catches the bug where a new utterance's report doesn't show up at all, or
  // silently replaces an unrelated one instead of being appended.
  it('appends a report for an utteranceId not seen before', () => {
    const state = latencyReducer(INITIAL_LATENCY_STATE, report({ utteranceId: 'utt_1' }));
    const next = latencyReducer(state, report({ utteranceId: 'utt_2' }));

    expect(next.reports.map((r) => r.utteranceId)).toEqual(['utt_1', 'utt_2']);
  });

  // Catches the bug this reducer's "keyed by id" shape exists to prevent: as later
  // latency.mark envelopes arrive for the same utterance, the report must be replaced
  // in place (staying at its original position) rather than duplicated as a second
  // entry alongside the first.
  it('replaces an existing utteranceId in place rather than duplicating it', () => {
    let state = latencyReducer(INITIAL_LATENCY_STATE, report({ utteranceId: 'utt_1', endToEndMs: null }));
    state = latencyReducer(state, report({ utteranceId: 'utt_2', endToEndMs: null }));
    state = latencyReducer(state, report({ utteranceId: 'utt_1', endToEndMs: 900 }));

    expect(state.reports).toHaveLength(2);
    expect(state.reports[0]).toEqual(report({ utteranceId: 'utt_1', endToEndMs: 900 }));
  });
});

describe('selectRecentReports', () => {
  // Catches the "no cap" bug: a long conversation must not grow the on-screen
  // breakdown table unbounded — only the most recently appeared N utterances show.
  it('returns only the most recently appeared reports, oldest first, up to the given limit', () => {
    let state = INITIAL_LATENCY_STATE;
    for (const id of ['a', 'b', 'c', 'd']) {
      state = latencyReducer(state, report({ utteranceId: id }));
    }

    expect(selectRecentReports(state, 2).map((r) => r.utteranceId)).toEqual(['c', 'd']);
  });
});

describe('selectLatencyAverages', () => {
  it('reports zero samples and null averages for an empty session', () => {
    expect(selectLatencyAverages(INITIAL_LATENCY_STATE)).toEqual({
      sampleCount: 0,
      stageAverages: [],
      endToEndAverageMs: null,
    });
  });

  // Catches the core averaging bug: the mean must actually divide by how many
  // utterances had that stage, not by the total utterance count — otherwise a stage
  // only some utterances reached (e.g. one utterance's TTS failed) would report a
  // deflated average.
  it('averages each stage only across the utterances that reported it', () => {
    const state = {
      reports: [
        report({ utteranceId: 'utt_1', stages: [{ stage: 'sttFinal', ms: 100 }], endToEndMs: 500 }),
        report({ utteranceId: 'utt_2', stages: [{ stage: 'sttFinal', ms: 300 }, { stage: 'mtFinal', ms: 50 }], endToEndMs: 700 }),
      ],
    };

    const averages = selectLatencyAverages(state);

    expect(averages.sampleCount).toBe(2);
    expect(averages.endToEndAverageMs).toBe(600);
    expect(averages.stageAverages).toEqual(
      expect.arrayContaining([
        { stage: 'sttFinal', ms: 200 }, // (100 + 300) / 2
        { stage: 'mtFinal', ms: 50 }, // only utt_2 had it
      ]),
    );
  });

  // Catches the crucial "no double-counting on an in-place update" bug this whole
  // recompute-from-scratch design exists to avoid: an utterance whose report changed
  // several times (as later marks arrived) must contribute its *latest* numbers to the
  // average exactly once, not once per update it ever received.
  it('counts an utterance whose report was replaced in place exactly once, using its latest numbers', () => {
    let state = latencyReducer(INITIAL_LATENCY_STATE, report({ utteranceId: 'utt_1', endToEndMs: 400 }));
    state = latencyReducer(state, report({ utteranceId: 'utt_1', endToEndMs: 900 }));

    const averages = selectLatencyAverages(state);

    expect(averages.sampleCount).toBe(1);
    expect(averages.endToEndAverageMs).toBe(900);
  });

  // Catches a bug where an utterance with no endToEndMs yet (still in progress) pulls
  // the average down toward zero instead of being excluded until it resolves.
  it('excludes reports with a null endToEndMs from the end-to-end average', () => {
    const state = {
      reports: [report({ utteranceId: 'utt_1', endToEndMs: 800 }), report({ utteranceId: 'utt_2', endToEndMs: null })],
    };

    expect(selectLatencyAverages(state).endToEndAverageMs).toBe(800);
  });
});
