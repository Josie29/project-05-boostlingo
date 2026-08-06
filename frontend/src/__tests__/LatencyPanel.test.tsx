import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LatencyPanel } from '../components/LatencyPanel';
import type { LatencyPanelProps } from '../components/LatencyPanel';
import { EMPTY_LATENCY_AVERAGES } from '../latency/types';

const BOTH_MODES: LatencyPanelProps['modes'] = [
  { mode: 'realtime', label: 'Realtime', targetMs: 1_500, averages: EMPTY_LATENCY_AVERAGES },
  { mode: 'cascade', label: 'Cascade', targetMs: 3_000, averages: EMPTY_LATENCY_AVERAGES },
];

function renderPanel(overrides: Partial<LatencyPanelProps> = {}) {
  const props: LatencyPanelProps = {
    modes: BOTH_MODES,
    recentReports: [],
    ...overrides,
  };
  render(<LatencyPanel {...props} />);
  return props;
}

describe('LatencyPanel', () => {
  // Catches a listener having no way to tell there's been no conversation yet
  // versus the panel being broken — each mode column plus the recent list say so.
  it('shows an empty state per mode column and for the recent list', () => {
    renderPanel();

    expect(screen.getAllByText('No utterances yet.')).toHaveLength(2);
    expect(screen.getByText('Nothing yet.')).toBeInTheDocument();
  });

  // Catches the regression this scoreboard exists to fix: both modes' averages
  // blended into one number judged against a single target. Each column must
  // show its own average against its own target.
  it('renders each mode column with its own average and target verdict', () => {
    renderPanel({
      modes: [
        {
          mode: 'realtime',
          label: 'Realtime',
          targetMs: 1_500,
          averages: { sampleCount: 2, stageAverages: [{ stage: 'audioStart', ms: 400 }], endToEndAverageMs: 1_113 },
        },
        {
          mode: 'cascade',
          label: 'Cascade',
          targetMs: 3_000,
          averages: { sampleCount: 3, stageAverages: [{ stage: 'sttFinal', ms: 276 }], endToEndAverageMs: 3_200 },
        },
      ],
    });

    expect(screen.getByText('1113ms')).toBeInTheDocument();
    expect(screen.getByText('✓ under 1.5s target')).toBeInTheDocument();
    // audioStart ends AT first audio out — voice generation, not spoken duration.
    expect(screen.getByText('Generating voice').parentElement).toHaveTextContent('400ms');

    expect(screen.getByText('3200ms')).toBeInTheDocument();
    expect(screen.getByText('▲ 200ms over 3.0s target')).toBeInTheDocument();
    expect(screen.getByText('Finalizing transcript').parentElement).toHaveTextContent('276ms');
  });

  // Catches a recent utterance judged against the wrong mode's target after a
  // mid-session switch: 2000ms is over Realtime's 1.5s but under Cascade's 3s,
  // so the verdict must come from the utterance's own mode.
  it('marks each recent utterance with its mode chip and judges it against that mode\'s target', () => {
    renderPanel({
      recentReports: [
        { utteranceId: 'realtime:turn-1', stages: [], endToEndMs: 2_000 },
        { utteranceId: 'cascade:item_1', stages: [], endToEndMs: 2_000 },
      ],
    });

    expect(screen.getByLabelText('realtime')).toHaveTextContent('RT');
    expect(screen.getByLabelText('cascade')).toHaveTextContent('CAS');
    expect(screen.getByText('▲ 500ms over target')).toBeInTheDocument();
    expect(screen.getByText('✓')).toBeInTheDocument();
  });

  // Catches an utterance still mid-flight rendering a confusing blank or stale
  // number instead of clearly showing it's pending.
  it("shows 'pending' for a report whose endToEndMs is not yet known", () => {
    renderPanel({ recentReports: [{ utteranceId: 'cascade:item_1', stages: [], endToEndMs: null }] });

    expect(screen.getByText('pending')).toBeInTheDocument();
  });

  // Catches dropped stage rows (the total alone says nothing about which stage was
  // slow), and raw mark names leaking back into the UI in place of the labels.
  it('renders a stage row per stage in a recent report', () => {
    renderPanel({
      recentReports: [
        {
          utteranceId: 'cascade:item_1',
          stages: [
            { stage: 'sttFinal', ms: 320 },
            { stage: 'mtFinal', ms: 140 },
          ],
          endToEndMs: 980,
        },
      ],
    });

    expect(screen.getByText('980ms')).toBeInTheDocument();
    expect(screen.getByText('Finalizing transcript').parentElement).toHaveTextContent('320ms');
    expect(screen.getByText('Finishing translation').parentElement).toHaveTextContent('140ms');
    expect(screen.queryByText(/sttFinal/)).not.toBeInTheDocument();
  });
});
