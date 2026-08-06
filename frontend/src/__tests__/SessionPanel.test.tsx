import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionPanel } from '../components/SessionPanel';
import type { SessionPanelProps } from '../components/SessionPanel';
import { EMPTY_LATENCY_AVERAGES } from '../latency/types';

function renderPanel(overrides: Partial<SessionPanelProps> = {}) {
  const props: SessionPanelProps = {
    mode: 'realtime',
    status: 'idle',
    errorMessage: null,
    errorKind: null,
    reconnectable: false,
    switching: false,
    transcriptEntries: [],
    latencyReports: [],
    latencyAveragesByMode: { realtime: EMPTY_LATENCY_AVERAGES, cascade: EMPTY_LATENCY_AVERAGES },
    notice: null,
    architecture: null,
    stageModels: {},
    onStageModelsChange: vi.fn(),
    stageModelsLocked: false,
    onModeChange: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
    onReconnect: vi.fn(),
    onDismissNotice: vi.fn(),
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

  const ARCHITECTURE = {
    realtime: { model: 'gpt-realtime' },
    cascade: {
      stt: { model: 'gpt-4o-mini-transcribe' },
      mt: { provider: 'openai', model: 'gpt-4o-mini' },
      mtAlternative: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      tts: { model: 'gpt-4o-mini-tts' },
      sttOptions: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe'],
    },
  };

  // Catches the architecture cards not actually saying what runs: realtime and TTS
  // show their models, and the STT/MT pickers default to the backend's active config.
  it('renders each paradigm\'s models, with pickers defaulting to the active config', () => {
    renderPanel({ architecture: ARCHITECTURE });

    expect(screen.getByText('gpt-realtime')).toBeInTheDocument();
    expect(screen.getByText('gpt-4o-mini-tts')).toBeInTheDocument();
    expect(screen.getByLabelText('STT model')).toHaveValue('gpt-4o-mini-transcribe');
    expect(screen.getByLabelText('MT provider')).toHaveValue('openai');
  });

  // Catches a stage pick not reaching the session config: choosing the alternate
  // STT model or MT provider must surface through onStageModelsChange.
  it('reports stage picker changes with the chosen model and provider', () => {
    const props = renderPanel({ architecture: ARCHITECTURE });

    fireEvent.change(screen.getByLabelText('STT model'), { target: { value: 'gpt-4o-transcribe' } });
    fireEvent.change(screen.getByLabelText('MT provider'), { target: { value: 'anthropic' } });

    expect(props.onStageModelsChange).toHaveBeenCalledWith({ sttModel: 'gpt-4o-transcribe' });
    expect(props.onStageModelsChange).toHaveBeenCalledWith({ mtProvider: 'anthropic' });
  });

  // Catches a mid-session model change silently not applying (the session already
  // negotiated its models at start): pickers must lock while a session is live.
  it('disables the stage pickers while locked', () => {
    renderPanel({ architecture: ARCHITECTURE, stageModelsLocked: true });

    expect(screen.getByLabelText('STT model')).toBeDisabled();
    expect(screen.getByLabelText('MT provider')).toBeDisabled();
  });

  // Catches the provider-swap story staying invisible: expanding the cascade
  // card's details must show the swap that selecting the other provider performs.
  it('reveals the MT provider swap in the cascade card\'s details', () => {
    renderPanel({ architecture: ARCHITECTURE });
    expect(screen.queryByText(/TRANSLATION_PROVIDER=anthropic/)).not.toBeInTheDocument();

    const cascadeCard = screen.getByRole('radio', { name: 'Cascade' });
    fireEvent.click(within(cascadeCard).getByRole('button', { name: 'Details' }));

    expect(screen.getByText(/TRANSLATION_PROVIDER=anthropic/)).toBeInTheDocument();
  });

  // Catches the details toggle hijacking selection: expanding a card's details
  // must not also switch the active mode.
  it('does not change mode when toggling a card\'s details', () => {
    const props = renderPanel({ mode: 'realtime', architecture: ARCHITECTURE });

    const cascadeCard = screen.getByRole('radio', { name: 'Cascade' });
    fireEvent.click(within(cascadeCard).getByRole('button', { name: 'Details' }));

    expect(props.onModeChange).not.toHaveBeenCalled();
  });

  // Catches the bug where the mode cards stay clickable mid-switch, letting a
  // listener fire off a second switch before the first tears its transport down.
  it('ignores mode card clicks while a switch is in progress', () => {
    const props = renderPanel({ switching: true });

    fireEvent.click(screen.getByRole('radio', { name: 'Cascade' }));

    expect(props.onModeChange).not.toHaveBeenCalled();
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

  // Catches the bug where the panel drops or duplicates whatever latency data it
  // was handed instead of forwarding it straight to the shared LatencyPanel (issue #10).
  it('forwards latencyReports and per-mode averages to the shared latency panel', () => {
    renderPanel({
      status: 'connected',
      latencyReports: [{ utteranceId: 'cascade:item_1', stages: [{ stage: 'sttFinal', ms: 210 }], endToEndMs: 900 }],
      latencyAveragesByMode: {
        realtime: EMPTY_LATENCY_AVERAGES,
        cascade: { sampleCount: 1, stageAverages: [{ stage: 'sttFinal', ms: 150 }], endToEndAverageMs: 800 },
      },
    });

    expect(screen.getByText('800ms')).toBeInTheDocument();
    expect(screen.getByText('900ms')).toBeInTheDocument();
    const [average, report] = screen.getAllByText('Finalizing transcript');
    expect(average.parentElement).toHaveTextContent('150ms');
    expect(report.parentElement).toHaveTextContent('210ms');
  });

  // Catches the target wiring bug: Realtime and Cascade have different targets
  // per the brief (1.5s vs 3s), and both must be visible at once — each column
  // judged against its own, regardless of which mode is active.
  it('shows both modes\' targets in the scoreboard at once', () => {
    renderPanel({
      mode: 'realtime',
      latencyAveragesByMode: {
        realtime: { sampleCount: 1, stageAverages: [], endToEndAverageMs: 1_000 },
        cascade: { sampleCount: 1, stageAverages: [], endToEndAverageMs: 2_000 },
      },
    });

    expect(screen.getByText('✓ under 1.5s target')).toBeInTheDocument();
    expect(screen.getByText('✓ under 3.0s target')).toBeInTheDocument();
  });

  // Catches the bug where a backend error surfaces silently (or not at all) instead
  // of showing the transport's own explanation of what went wrong.
  it('shows the error message when status is error', () => {
    renderPanel({ status: 'error', errorMessage: 'The cascade WebSocket connection failed.' });

    expect(screen.getByRole('alert')).toHaveTextContent('The cascade WebSocket connection failed.');
  });

  // Catches the bug where a generic (non-reconnectable) error offers no way back in —
  // a listener whose token mint failed, or whose mic permission was denied, needs a
  // button that actually retries rather than a dead end.
  it('shows a "Try again" button (not Reconnect) for a non-reconnectable error, wired to onStart', () => {
    const props = renderPanel({ status: 'error', errorMessage: 'Failed to create realtime session (status 503).', reconnectable: false });

    const retryButton = screen.getByRole('button', { name: 'Try again' });
    expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();

    fireEvent.click(retryButton);

    expect(props.onStart).toHaveBeenCalledOnce();
  });

  // Catches the core issue #12 acceptance criterion for a mid-session death: the
  // affordance offered must be Reconnect (teardown + fresh start, same pair,
  // transcript preserved) rather than the plain "Try again" a pre-connect failure gets.
  it('shows a "Reconnect" button (not Try again) when reconnectable, wired to onReconnect', () => {
    const props = renderPanel({ status: 'error', errorMessage: 'The realtime connection was lost.', reconnectable: true });

    const reconnectButton = screen.getByRole('button', { name: 'Reconnect' });
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();

    fireEvent.click(reconnectButton);

    expect(props.onReconnect).toHaveBeenCalledOnce();
  });

  // Catches the bug this issue is centrally about: a mic permission denial rendering
  // as the same undifferentiated error as any other failure, leaving a listener with
  // no idea what to actually do about it.
  it('renders mic-permission guidance text for a "mic-denied" error, distinct from "mic-not-found"', () => {
    renderPanel({ status: 'error', errorMessage: 'Microphone access was blocked.', errorKind: 'mic-denied' });

    expect(screen.getByText(/allow microphone access/i)).toBeInTheDocument();
    expect(screen.queryByText(/connect a microphone/i)).not.toBeInTheDocument();
  });

  it('renders mic-not-found guidance text for a "mic-not-found" error', () => {
    renderPanel({ status: 'error', errorMessage: 'No microphone was found.', errorKind: 'mic-not-found' });

    expect(screen.getByText(/connect a microphone/i)).toBeInTheDocument();
  });

  // Catches the bug where mic guidance renders for every error, drowning out the
  // (already sufficient) plain message for a generic failure with irrelevant text.
  it('renders no guidance text when errorKind is null', () => {
    renderPanel({ status: 'error', errorMessage: 'Something else failed.', errorKind: null });

    expect(screen.queryByText(/allow microphone access/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/connect a microphone/i)).not.toBeInTheDocument();
  });

  // Catches the bug where a non-fatal, per-stage notice either never renders (a
  // listener has no idea one utterance failed) or renders in a way indistinguishable
  // from a fatal error (making a still-connected session look dead).
  it('renders a dismissible notice strip while connected, separate from the fatal error panel', () => {
    const props = renderPanel({
      status: 'connected',
      notice: { id: 'notice_1', message: 'Machine translation failed for one utterance.' },
    });

    expect(screen.getByRole('status')).toHaveTextContent('Machine translation failed for one utterance.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(props.onDismissNotice).toHaveBeenCalledOnce();
  });

  // Catches a stale-notice bug: a notice from a since-ended session lingering on
  // screen after the session dropped to idle/error would misleadingly suggest the
  // session is still connected and running.
  it('does not render a notice once status is no longer connected', () => {
    renderPanel({ status: 'idle', notice: { id: 'notice_1', message: 'Machine translation failed for one utterance.' } });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
