import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackendStatus } from '../components/BackendStatus';

describe('BackendStatus', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Catches the bug where the dev proxy or backend is down but the UI
  // still claims "connected" — that kind of silent integration failure
  // goes unnoticed until a later screen breaks.
  it('renders "connected" once /healthz resolves ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'ok' }),
      }),
    );

    render(<BackendStatus />);

    expect(screen.getByText('Checking backend...')).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByText('Backend connected')).toBeInTheDocument(),
    );
  });

  // Catches the bug where a failed health check gets swallowed and the UI
  // reports success even though the backend is unreachable.
  it('renders "unreachable" when the health check fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({}),
      }),
    );

    render(<BackendStatus />);

    await waitFor(() =>
      expect(screen.getByText('Backend unreachable')).toBeInTheDocument(),
    );
  });

  // Catches the bug where starting the backend after the page loads left the
  // badge stuck on "unreachable" forever until a manual refresh.
  it('recovers to "connected" when a later poll succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'ok' }),
      });
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();

    try {
      render(<BackendStatus />);

      // Flush only the first (failing) poll's promise, no timer advance yet.
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByText('Backend unreachable')).toBeInTheDocument();

      // Advance past the re-check interval; the second poll succeeds.
      await act(() => vi.advanceTimersByTimeAsync(5000));
      expect(screen.getByText('Backend connected')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
