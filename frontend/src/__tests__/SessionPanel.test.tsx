import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionPanel } from '../components/SessionPanel';
import type { SessionPanelProps } from '../components/SessionPanel';
import { EMPTY_LATENCY_AVERAGES } from '../latency/types';

function renderPanel(overrides: Partial<SessionPanelProps> = {}) {
  const props: SessionPanelProps = {
    mode: 'realtime',
    status: 'idle',
    errorMessage: null,
    switching: false,
    transcriptEntries: [],
    latencyReports: [],
    latencyAverages: EMPTY_LATENCY_AVERAGES,
    onModeChange: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
    ...overrides,
  };
  render(<SessionPanel {...props} />);
  return props;
}

describe('SessionPanel', () => {
  // Catches the bug where the toggle doesn't reflect which transport is actually
  // active, leaving a listener unable to tell Realtime and Cascade apart at a glance.
  it('marks the active mode button and leaves the other inactive', () => {
    renderPanel({ mode: 'cascade' });

    expect(screen.getByRole('radio', { name: 'Cascade' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Realtime' })).toHaveAttribute('aria-checked', 'false');
  });

  // Catches the bug where clicking the toggle doesn't actually forward the
  // listener's choice up to whatever owns the real mode-switching logic.
  it('calls onModeChange with the clicked mode', () => {
    const props = renderPanel({ mode: 'realtime' });

    fireEvent.click(screen.getByRole('radio', { name: 'Cascade' }));

    expect(props.onModeChange).toHaveBeenCalledWith('cascade');
  });

  // Catches the bug where the toggle stays clickable mid-switch, letting a listener
  // fire off a second switch before the first one has torn its transport down.
  it('disables both mode buttons while a switch is in progress', () => {
    renderPanel({ switching: true });

    expect(screen.getByRole('radio', { name: 'Realtime' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Cascade' })).toBeDisabled();
  });

  // Catches the bug where "switching..." never renders, leaving a listener staring
  // at a stale status with no indication anything is happening mid-toggle.
  it('shows a switching indicator naming the target mode instead of the raw status label', () => {
    renderPanel({ mode: 'cascade', status: 'connecting', switching: true });

    expect(screen.getByText('Switching to Cascade...')).toBeInTheDocument();
    expect(screen.queryByText('Connecting...')).not.toBeInTheDocument();
  });

  // Catches the bug where Start/Stop stop actually driving the session because the
  // panel wires them to something other than the callbacks it was given.
  it('wires Start and Stop to the given callbacks', () => {
    const props = renderPanel({ status: 'connected' });

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    expect(props.onStop).toHaveBeenCalledOnce();
    expect(props.onStart).not.toHaveBeenCalled();
  });

  // Catches the bug where Start/Stop stay clickable mid-switch, letting a listener
  // interfere with the switch already underway.
  it('disables Start and Stop while a switch is in progress', () => {
    renderPanel({ status: 'connected', switching: true });

    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
  });

  // Catches the bug where the panel drops or duplicates whatever transcript entries
  // it was handed instead of forwarding them straight to the shared TranscriptPanel.
  it('forwards transcriptEntries to the shared transcript panel', () => {
    renderPanel({
      status: 'connected',
      transcriptEntries: [{ id: 'utt_1', lane: 'source', text: 'Hello there', final: true }],
    });

    const sourceColumn = screen.getByText('Source').closest('.transcript-panel__column');
    expect(sourceColumn).toContainElement(screen.getByText('Hello there'));
  });

  // Catches the bug where the panel drops or duplicates whatever latency reports it
  // was handed instead of forwarding them straight to the shared LatencyPanel (issue #10).
  it('forwards latencyReports and latencyAverages to the shared latency panel', () => {
    renderPanel({
      status: 'connected',
      latencyReports: [{ utteranceId: 'cascade:item_1', stages: [{ stage: 'sttFinal', ms: 210 }], endToEndMs: 900 }],
      latencyAverages: { sampleCount: 1, stageAverages: [{ stage: 'sttFinal', ms: 150 }], endToEndAverageMs: 800 },
    });

    expect(screen.getByText('Avg end-to-end: 800ms')).toBeInTheDocument();
    expect(screen.getByText('sttFinal: 150ms')).toBeInTheDocument();
    expect(screen.getByText('900ms')).toBeInTheDocument();
    expect(screen.getByText('sttFinal: 210ms')).toBeInTheDocument();
  });

  // Catches the bug where a backend error surfaces silently (or not at all) instead
  // of showing the transport's own explanation of what went wrong.
  it('shows the error message when status is error', () => {
    renderPanel({ status: 'error', errorMessage: 'The cascade WebSocket connection failed.' });

    expect(screen.getByRole('alert')).toHaveTextContent('The cascade WebSocket connection failed.');
  });
});
