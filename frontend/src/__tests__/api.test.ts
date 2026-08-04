import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRealtimeSession, getLanguages } from '../api';

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

  // Catches the core wiring bug issue #8 is about: a selected language pair that never
  // reaches the POST body would silently fall back to the backend's en/es default no
  // matter what a listener picked in the selector.
  it('sends the given language pair as the JSON request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ clientSecret: 'ek_abc', expiresAt: 1730000000, model: 'gpt-realtime' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await createRealtimeSession({ sourceLang: 'es', targetLang: 'en' });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/realtime/session',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ sourceLang: 'es', targetLang: 'en' }),
      }),
    );
  });

  // Catches a regression where always sending a body (even an implicit default) would
  // break backward compatibility with the pre-issue-#8 no-body call the backend still
  // accepts and defaults to en/es.
  it('sends no request body when no pair is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ clientSecret: 'ek_abc', expiresAt: 1730000000, model: 'gpt-realtime' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await createRealtimeSession();

    expect(fetchMock).toHaveBeenCalledWith('/api/realtime/session', { method: 'POST' });
  });
});

describe('getLanguages', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Catches the bug where the selector hardcodes its options instead of rendering
  // whatever languages the backend's registry actually reports.
  it('returns every language from the /api/languages response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          languages: [
            { code: 'en', displayName: 'English' },
            { code: 'es', displayName: 'Spanish' },
          ],
        }),
      }),
    );

    const result = await getLanguages();

    expect(result).toEqual([
      { code: 'en', displayName: 'English' },
      { code: 'es', displayName: 'Spanish' },
    ]);
  });

  it('throws when the response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    await expect(getLanguages()).rejects.toThrow('status 500');
  });
});
