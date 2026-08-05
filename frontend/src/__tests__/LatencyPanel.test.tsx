import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LatencyPanel } from '../components/LatencyPanel';
import type { LatencyPanelProps } from '../components/LatencyPanel';
import { EMPTY_LATENCY_AVERAGES } from '../latency/types';

function renderPanel(overrides: Partial<LatencyPanelProps> = {}) {
  const props: LatencyPanelProps = {
    benchmarkMs: 3_000,
    recentReports: [],
    averages: EMPTY_LATENCY_AVERAGES,
    ...overrides,
  };
  render(<LatencyPanel {...props} />);
  return props;
}

describe('LatencyPanel', () => {
  // Catches the bug where a listener has no way to tell there's simply been no
  // conversation yet, versus the panel being broken.
  it('shows an empty state for both sections when no reports have arrived', () => {
    renderPanel();

    expect(screen.getAllByText(/nothing yet|no utterances yet/i)).toHaveLength(2);
  });

  // Catches the core rendering bug this component exists to avoid: a per-utterance
  // stage breakdown that doesn't actually show each stage's own row, leaving a
  // listener with only the total and no insight into which stage was slow.
  it('renders a stage row per stage in a recent report, plus its overall total', () => {
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
    expect(screen.getByText('sttFinal: 320ms')).toBeInTheDocument();
    expect(screen.getByText('mtFinal: 140ms')).toBeInTheDocument();
  });

  // Catches a bug where an utterance still mid-flight (no marks resolved enough for
  // an endToEndMs yet) renders a confusing blank or a stale number instead of clearly
  // showing it's still pending.
  it("shows 'pending' for a report whose endToEndMs is not yet known", () => {
    renderPanel({ recentReports: [{ utteranceId: 'cascade:item_1', stages: [], endToEndMs: null }] });

    expect(screen.getByText('pending')).toBeInTheDocument();
  });

  // Catches the core averages-rendering bug: the session summary must show the
  // running average, not just repeat the most recent utterance's own numbers.
  it('renders the session averages section once samples exist', () => {
    renderPanel({
      averages: { sampleCount: 3, stageAverages: [{ stage: 'sttFinal', ms: 250 }], endToEndAverageMs: 1_000 },
    });

    expect(screen.getByText('Avg end-to-end: 1000ms')).toBeInTheDocument();
    expect(screen.getByText('sttFinal: 250ms')).toBeInTheDocument();
  });

  // Catches a formatting bug: this panel renders whatever `benchmarkMs` it's
  // given (mode->benchmark mapping is `SessionPanel`'s job, not this
  // mode-agnostic panel's — see `SessionPanel.test.tsx` for that mapping)
  // — the hint text must reflect that exact value, in seconds.
  it('shows the given benchmark hint, in seconds', () => {
    renderPanel({ benchmarkMs: 1_500 });
    expect(screen.getByText('Target: under 1.5s')).toBeInTheDocument();

    render(<LatencyPanel benchmarkMs={3_000} recentReports={[]} averages={EMPTY_LATENCY_AVERAGES} />);
    expect(screen.getByText('Target: under 3.0s')).toBeInTheDocument();
  });
});
