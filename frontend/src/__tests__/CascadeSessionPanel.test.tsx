import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CascadeSessionPanel } from '../components/CascadeSessionPanel';
import { useCascadeSession } from '../cascade/useCascadeSession';
import type { UseCascadeSessionResult } from '../cascade/useCascadeSession';

// `useCascadeSession` owns the real WebSocket/AudioContext transport (untestable in
// jsdom — see MicPcmCapture's own doc comment), so this panel is tested against a
// mocked hook, mirroring how CascadeSessionController's own tests fake the transport
// one layer down. That keeps this test focused on what the panel is actually
// responsible for: rendering the hook's state and forwarding transcriptEntries to
// the shared TranscriptPanel, not re-proving the transport works.
vi.mock('../cascade/useCascadeSession', () => ({
  useCascadeSession: vi.fn(),
}));

const mockedUseCascadeSession = useCascadeSession as unknown as ReturnType<typeof vi.fn>;

function stubHook(overrides: Partial<UseCascadeSessionResult> = {}): void {
  mockedUseCascadeSession.mockReturnValue({
    status: 'idle',
    errorMessage: null,
    start: vi.fn(),
    stop: vi.fn(),
    transcriptEntries: [],
    ...overrides,
  } satisfies UseCascadeSessionResult);
}

describe('CascadeSessionPanel', () => {
  // Catches the bug where the shared TranscriptPanel is never mounted at all, so a
  // listener sees no indication that a transcript will show up once a session starts.
  it('renders the shared transcript panel with its empty state before a session starts', () => {
    stubHook();

    render(<CascadeSessionPanel />);

    expect(screen.getAllByText('Nothing yet.')).toHaveLength(2);
  });

  // Catches the core wiring bug this issue is about: the panel must pass whatever
  // transcriptEntries the hook produces straight through to TranscriptPanel's source
  // column, rather than dropping them or rendering its own disconnected copy.
  it('renders source-lane entries the hook reports into the source column', () => {
    stubHook({
      status: 'connected',
      transcriptEntries: [{ id: 'utt_1', lane: 'source', text: 'Hello there', final: true }],
    });

    render(<CascadeSessionPanel />);

    const sourceColumn = screen.getByText('Source').closest('.transcript-panel__column');
    expect(sourceColumn).toContainElement(screen.getByText('Hello there'));
    expect(screen.getByText('Hello there')).toHaveAttribute('data-final', 'true');
  });

  // Catches the bug where an in-progress partial renders identically to a finalized
  // entry, leaving a listener with no way to tell what's still streaming.
  it('marks a not-yet-final entry as in progress', () => {
    stubHook({
      status: 'connected',
      transcriptEntries: [{ id: 'utt_1', lane: 'source', text: 'Hel', final: false }],
    });

    render(<CascadeSessionPanel />);

    expect(screen.getByText('Hel')).toHaveAttribute('data-final', 'false');
  });

  // Catches the bug where the Start/Stop buttons stop actually driving the session
  // because the panel wires them to something other than the hook's start/stop.
  it('wires the Start and Stop buttons to the hook', () => {
    const start = vi.fn();
    const stop = vi.fn();
    stubHook({ status: 'connected', start, stop });

    render(<CascadeSessionPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    expect(stop).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
  });
});
