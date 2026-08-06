import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ExperimentReport, type ExperimentReportData } from '../components/ExperimentReport';
import { computeWer } from '../lab/wer';

const RESULT: ExperimentReportData = {
  title: 'Run report · benchmark-practice.m4a',
  wer: computeWer('take one tablet daily', 'take a tablet twice daily'),
  utteranceCount: 2,
  transcript: [
    { id: 'cascade:u1', lane: 'source', text: 'take a tablet', final: true },
    { id: 'cascade:u2', lane: 'source', text: 'twice daily', final: true },
    { id: 'cascade:u1-target', lane: 'target', text: 'tome una tableta', final: true },
  ],
  latencyReports: [
    {
      utteranceId: 'cascade:u1',
      stages: [
        { stage: 'sttFinal', ms: 300 },
        { stage: 'mtFirstToken', ms: 500 },
        { stage: 'ttsFirstByte', ms: 700 },
      ],
      endToEndMs: 1_500,
    },
    { utteranceId: 'cascade:u2', stages: [{ stage: 'sttFinal', ms: 400 }], endToEndMs: 3_000 },
  ],
};

describe('ExperimentReport', () => {
  // Catches the report reverting to a bare verdict: the WER headline, the
  // error-kind breakdown, and the latency medians must all be on screen.
  it('renders the verdict tiles', () => {
    render(<ExperimentReport data={RESULT} />);

    expect(screen.getByText('50.0%')).toBeInTheDocument();
    expect(screen.getByText('1S · 1I · 0D')).toBeInTheDocument();
    expect(screen.getByText('2250ms')).toBeInTheDocument();
  });

  // Catches the diff losing its meaning: a substitution must show BOTH words
  // (struck original, marked replacement), and an insertion must be marked —
  // structure, not color alone.
  it('renders substitutions with both words and marks insertions', () => {
    render(<ExperimentReport data={RESULT} />);

    expect(screen.getByText('one').tagName).toBe('DEL');
    expect(screen.getByText('a').tagName).toBe('MARK');
    expect(screen.getByTitle('word nobody said').tagName).toBe('MARK');
  });

  // Catches the caller's actual experience going missing: both lanes' text
  // must render, in order.
  it('renders the source and target transcript pair', () => {
    render(<ExperimentReport data={RESULT} />);

    expect(screen.getByText('take a tablet twice daily')).toBeInTheDocument();
    expect(screen.getByText('tome una tableta')).toBeInTheDocument();
  });

  // Catches the slowest utterance hiding in the crowd: the worst end-to-end
  // row must be flagged.
  it('flags the slowest utterance', () => {
    render(<ExperimentReport data={RESULT} />);

    expect(screen.getByText('3000ms ▲')).toBeInTheDocument();
  });

  // Catches a live session's detail view pretending it was scored: with no
  // ground truth the WER tiles and diff must be absent while the transcript
  // and latency evidence still render.
  it('omits the WER sections when there is no ground truth', () => {
    render(<ExperimentReport data={{ ...RESULT, wer: null }} />);

    expect(screen.queryByText(/%$/)).not.toBeInTheDocument();
    expect(screen.queryByText('Recognition vs ground truth')).not.toBeInTheDocument();
    expect(screen.getByText('take a tablet twice daily')).toBeInTheDocument();
    expect(screen.getByText('2250ms')).toBeInTheDocument();
  });
});
