import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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
    mtModel: 'gpt-4o-mini',
    ttsModel: 'gpt-4o-mini-tts',
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
      stages: [
        { stage: 'ttsFirstByte', stats: { count: 3, medianMs: 998, p95Ms: 1200 } },
        { stage: 'ttsEnd', stats: { count: 3, medianMs: 787, p95Ms: 900 } },
      ],
    },
  ],
};

const DETAIL = {
  conversationId: 'conv-1',
  sourceLang: 'en',
  targetLang: 'es',
  translationProvider: 'openai',
  sttModel: 'gpt-4o-mini-transcribe',
  mtModel: 'gpt-4o-mini',
  ttsModel: 'gpt-4o-mini-tts',
  startedAtMs: 1_754_400_000_000,
  endedAtMs: 1_754_400_060_000,
  kind: 'experiment',
  wer: 0.25,
  fixture: 'practice.m4a',
  groundTruth: 'take one tablet daily',
  utterances: [
    { utteranceId: 'cascade:u1', mode: 'cascade', endToEndMs: 1500, stages: [{ stage: 'sttFinal', ms: 300 }] },
  ],
  transcript: [{ utteranceId: 'cascade:u1', lane: 'source', text: 'take a tablet daily', final: true }],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn((url: string) => {
    const path = url.toString();
    const body = path.includes('scope=baseline')
      ? BASELINE_SUMMARY
      : path.includes('/api/metrics/conversations/')
        ? DETAIL
        : path.includes('/baseline')
          ? {}
          : { conversations: CONVERSATIONS };
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('LabPanel', () => {
  // Catches the baseline card showing numbers from the wrong scope (the pane
  // must report what's pinned, not a pooled all-sessions median) or dropping the
  // stage breakdown under the headline.
  it('renders the pinned baseline median and stage breakdown for a pinned mode', async () => {
    render(<LabPanel pair={{ sourceLang: 'en', targetLang: 'es' }} stageModels={{}} />);

    expect(await screen.findByText('Cascade')).toBeInTheDocument();
    // Scoped to the pane: the conversations table below repeats the same median.
    const pane = within(screen.getByRole('region', { name: 'Baseline' }));
    expect(pane.getByText('2457ms')).toBeInTheDocument();
    expect(pane.getByText('Generating voice').parentElement).toHaveTextContent('998ms');
    // ttsEnd elapses after first audio out, so it sits under the rule as an
    // aside — never as a row that reads like part of the headline latency.
    expect(pane.getByText('Not latency — the listener is already hearing it.')).toBeInTheDocument();
    expect(pane.getByText('Audio plays out').closest('ul')).toHaveAttribute('data-after', 'true');
  });

  // Catches the pane collapsing to one card when only one mode is pinned: both
  // modes must always hold their space, the unpinned one telling you how to fill it.
  it('keeps a card for an unpinned mode with a prompt to pin one', async () => {
    render(<LabPanel pair={{ sourceLang: 'en', targetLang: 'es' }} stageModels={{}} />);
    await screen.findByText('Cascade');

    expect(screen.getByText('Realtime')).toBeInTheDocument();
    expect(screen.getByText('Nothing pinned. Pin a realtime run below to populate this.')).toBeInTheDocument();
  });

  // Catches a row's pin toggle not actually changing the set: unpinning the only
  // pinned conversation must post an empty set (and pinning posts the full new set).
  it('toggles a single conversation in and out of the baseline set', async () => {
    render(<LabPanel pair={{ sourceLang: 'en', targetLang: 'es' }} stageModels={{}} />);
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
    render(<LabPanel pair={{ sourceLang: 'en', targetLang: 'es' }} stageModels={{}} />);

    expect(await screen.findByRole('button', { name: 'Pinned' })).toHaveAttribute('aria-pressed', 'true');
  });

  // Catches a stored run being unopenable: View must fetch the detail and render
  // the same report — including the WER diff recomputed from the stored ground
  // truth (the substituted word appears struck).
  it('opens a stored run into the report from its View button', async () => {
    render(<LabPanel pair={{ sourceLang: 'en', targetLang: 'es' }} stageModels={{}} />);
    await screen.findByText('Cascade');

    fireEvent.click(screen.getByRole('button', { name: 'View' }));

    expect(await screen.findByText('experiment · practice.m4a')).toBeInTheDocument();
    expect(screen.getByText('25.0%')).toBeInTheDocument();
    expect(screen.getByText('one').tagName).toBe('DEL');
  });

  // Catches the escape hatch missing: clearing must post an empty baseline set.
  it('clears the baseline from the progress header', async () => {
    render(<LabPanel pair={{ sourceLang: 'en', targetLang: 'es' }} stageModels={{}} />);
    await screen.findByText('Cascade');

    fireEvent.click(screen.getByRole('button', { name: 'Clear baseline' }));

    await waitFor(() => {
      const pinCall = fetchMock.mock.calls.find(([url]) => (url as string).includes('/api/metrics/baseline'));
      expect(JSON.parse((pinCall![1] as RequestInit).body as string)).toEqual({ conversationIds: [] });
    });
  });
});
