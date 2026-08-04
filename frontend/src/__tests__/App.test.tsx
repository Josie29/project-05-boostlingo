import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { EMPTY_LATENCY_AVERAGES } from '../latency/types';
import { useInterpreterSession } from '../session/useInterpreterSession';
import type { UseInterpreterSessionResult } from '../session/useInterpreterSession';

// `App` now drives everything through the single `useInterpreterSession` hook
// (issue #9), so it's tested against a mocked hook the same way `CascadeSessionPanel`
// used to mock `useCascadeSession` — this keeps the test focused on what App itself
// is responsible for (wiring the hook's state to the selector/panel), not re-proving
// either transport works.
vi.mock('../session/useInterpreterSession', () => ({
  useInterpreterSession: vi.fn(),
}));

const mockedUseInterpreterSession = useInterpreterSession as unknown as ReturnType<typeof vi.fn>;

function stubHook(overrides: Partial<UseInterpreterSessionResult> = {}): void {
  mockedUseInterpreterSession.mockReturnValue({
    mode: 'realtime',
    status: 'idle',
    errorMessage: null,
    errorKind: null,
    reconnectable: false,
    switching: false,
    transcriptEntries: [],
    latencyReports: [],
    latencyAverages: EMPTY_LATENCY_AVERAGES,
    notice: null,
    setMode: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    reconnect: vi.fn(),
    dismissNotice: vi.fn(),
    ...overrides,
  } satisfies UseInterpreterSessionResult);
}

/** Stubs the two backend calls the rest of the shell still makes directly: `/healthz` (BackendStatus) and `/api/languages` (LanguagePairSelector). */
function stubBackendFetches(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.toString().includes('/api/languages')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            languages: [
              { code: 'en', displayName: 'English' },
              { code: 'es', displayName: 'Spanish' },
            ],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ status: 'ok' }) });
    }),
  );
}

describe('App', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Catches the regression this issue's refactor makes possible: with the old
  // `isRealtimeActive || isCascadeActive` pair of callbacks gone, the selector's
  // disabled state must still be keyed off the single unified session state
  // (`isLiveStatus(status)`) rather than silently never disabling because nothing
  // wires it up anymore.
  it('disables the language selector while the unified session is connected', async () => {
    stubBackendFetches();
    stubHook({ status: 'connected' });

    render(<App />);

    await waitFor(() => expect(screen.getByLabelText('Source')).toBeDisabled());
  });

  // Catches the bug where a mid-session mode switch (status back to 'idle'/'connecting'
  // for a beat while the new transport spins up) leaves the selector briefly editable —
  // `switching` has to gate it too, not just `status`.
  it('disables the language selector while a mid-session mode switch is in flight', async () => {
    stubBackendFetches();
    stubHook({ status: 'idle', switching: true });

    render(<App />);

    await waitFor(() => expect(screen.getByLabelText('Source')).toBeDisabled());
  });

  it('leaves the language selector enabled when idle and no switch is in flight', async () => {
    stubBackendFetches();
    stubHook({ status: 'idle', switching: false });

    render(<App />);

    await waitFor(() => expect(screen.getByLabelText('Source')).not.toBeDisabled());
  });
});
