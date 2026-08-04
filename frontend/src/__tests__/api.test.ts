import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRealtimeSession } from '../api';

describe('createRealtimeSession', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the client secret, expiry, and model on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ clientSecret: 'ek_abc', expiresAt: 1730000000, model: 'gpt-realtime' }),
      }),
    );

    const result = await createRealtimeSession();

    expect(result).toEqual({ clientSecret: 'ek_abc', expiresAt: 1730000000, model: 'gpt-realtime' });
  });

  // Catches the bug where a missing server-side OpenAI key (503) surfaces to the
  // caller as a generic/opaque failure instead of the backend's own explanation —
  // the UI relies on this message to tell an operator exactly what's misconfigured.
  it('throws with the backend error message on a 503 (no server key configured)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ error: 'The server is not configured with an OpenAI API key.' }),
      }),
    );

    await expect(createRealtimeSession()).rejects.toThrow(
      'The server is not configured with an OpenAI API key.',
    );
  });

  it('throws with the backend error message on a 502 (upstream failure)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => ({ error: 'Failed to create a realtime session with the upstream provider.' }),
      }),
    );

    await expect(createRealtimeSession()).rejects.toThrow(
      'Failed to create a realtime session with the upstream provider.',
    );
  });

  it('falls back to a status-code message when the error body is unreadable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('not json');
        },
      }),
    );

    await expect(createRealtimeSession()).rejects.toThrow('status 500');
  });
});
