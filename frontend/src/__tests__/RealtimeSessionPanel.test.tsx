import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RealtimeSessionPanel } from '../components/RealtimeSessionPanel';

describe('RealtimeSessionPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Catches the bug where a missing server-side OpenAI key (503 from
  // /api/realtime/session) fails silently or shows a generic error instead of
  // the backend's own explanation — a developer/operator needs this message
  // to know exactly what's misconfigured.
  it('surfaces the backend 503 error message when Start is clicked with no server key configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ error: 'The server is not configured with an OpenAI API key.' }),
      }),
    );
    // The session negotiates mic capture before requesting the token; stub
    // getUserMedia so jsdom's lack of real media devices doesn't block the test.
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) },
    });

    render(<RealtimeSessionPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() =>
      expect(
        screen.getByText('The server is not configured with an OpenAI API key.'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText('Error')).toBeInTheDocument();
  });
});
