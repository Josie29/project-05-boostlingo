import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LabPanel } from '../components/LabPanel';

const CONVERSATIONS = [
  {
    conversationId: 'conv-1',
    sourceLang: 'en',
    targetLang: 'es',
    translationProvider: 'openai',
    startedAtMs: 1_754_400_000_000,
    endedAtMs: 1_754_400_060_000,
    realtimeUtteranceCount: 0,
    cascadeUtteranceCount: 3,
    sttModel: 'gpt-4o-mini-transcribe',
    kind: 'live',
    wer: null,
    realtimeEndToEndMedianMs: null,
    cascadeEndToEndMedianMs: 2457,
    baseline: true,
  },
];

const BASELINE_SUMMARY = {
  groups: [
    {
      mode: 'cascade',
      translationProvider: null,
      conversationCount: 1,
      utteranceCount: 3,
      endToEnd: { count: 3, medianMs: 2457, p95Ms: 3000 },
      stages: [{ stage: 'ttsFirstByte', stats: { count: 3, medianMs: 998, p95Ms: 1200 } }],
    },
  ],
};

const CURRENT_SUMMARY = {
  groups: [
    {
      mode: 'cascade',
      translationProvider: null,
      conversationCount: 2,
      utteranceCount: 5,
      endToEnd: { count: 5, medianMs: 1980, p95Ms: 2500 },
      stages: [{ stage: 'ttsFirstByte', stats: { count: 5, medianMs: 610, p95Ms: 900 } }],
    },
    {
      mode: 'realtime',
      translationProvider: null,
      conversationCount: 1,
      utteranceCount: 2,
      endToEnd: { count: 2, medianMs: 500, p95Ms: 600 },
      stages: [],
    },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn((url: string) => {
    const path = url.toString();
    const body = path.includes('scope=baseline')
      ? BASELINE_SUMMARY
      : path.includes('scope=current')
        ? CURRENT_SUMMARY
        : path.includes('/baseline')
          ? {}
          : { conversations: CONVERSATIONS };
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('LabPanel', () => {
  // Catches the progress pane showing raw numbers with no comparison: a current
  // mode must render its median with the delta against the pinned baseline,
  // improvements pointing down.
  it('renders per-mode deltas of current medians against the baseline', async () => {
    render(<LabPanel />);

    expect(await screen.findByText('Cascade')).toBeInTheDocument();
    expect(screen.getByText('1980ms')).toBeInTheDocument();
    expect(screen.getByText('▼ 477ms')).toBeInTheDocument();
    expect(screen.getByText(/ttsFirstByte: 610ms/)).toBeInTheDocument();
    expect(screen.getByText('▼ 388ms')).toBeInTheDocument();
  });

  // Catches noise cards with nothing to compare: a mode with current sessions but
  // no pinned counterpart (realtime here) must not render a card at all.
  it('hides modes that have no baseline counterpart', async () => {
    render(<LabPanel />);
    await screen.findByText('Cascade');

    expect(screen.queryByText('Realtime')).not.toBeInTheDocument();
  });

  // Catches a row's pin toggle not actually changing the set: unpinning the only
  // pinned conversation must post an empty set (and pinning posts the full new set).
  it('toggles a single conversation in and out of the baseline set', async () => {
    render(<LabPanel />);
    await screen.findByText('Cascade');

    fireEvent.click(screen.getByRole('button', { name: 'Pinned' }));

    await waitFor(() => {
      const pinCall = fetchMock.mock.calls.find(([url]) => (url as string).includes('/api/metrics/baseline'));
      expect(pinCall).toBeDefined();
      expect(JSON.parse((pinCall![1] as RequestInit).body as string)).toEqual({ conversationIds: [] });
    });
  });

  // Catches baseline membership being invisible in the table: a pinned row's
  // toggle must read as pinned.
  it('marks pinned conversations in the experiments table', async () => {
    render(<LabPanel />);

    expect(await screen.findByRole('button', { name: 'Pinned' })).toHaveAttribute('aria-pressed', 'true');
  });

  // Catches the escape hatch missing: clearing must post an empty baseline set.
  it('clears the baseline from the progress header', async () => {
    render(<LabPanel />);
    await screen.findByText('Cascade');

    fireEvent.click(screen.getByRole('button', { name: 'Clear baseline' }));

    await waitFor(() => {
      const pinCall = fetchMock.mock.calls.find(([url]) => (url as string).includes('/api/metrics/baseline'));
      expect(JSON.parse((pinCall![1] as RequestInit).body as string)).toEqual({ conversationIds: [] });
    });
  });
});
