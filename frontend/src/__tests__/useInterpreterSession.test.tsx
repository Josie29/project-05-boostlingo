import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LanguagePair } from '../api';
import type { LatencyReport } from '../latency/types';
import type { InterpreterSession, SessionMode, SessionNotice, SessionState } from '../session/InterpreterSession';
import { useInterpreterSession } from '../session/useInterpreterSession';
import type { TranscriptUpdate } from '../transcript/types';

/**
 * A minimal fake `InterpreterSession` whose `start()` settles synchronously
 * (no real transport delay) — enough to exercise `useInterpreterSession`'s
 * own logic in isolation from either real adapter. `callOrder` is shared
 * across a test's two fakes so ordering (stop-before-start) can be asserted.
 */
function createInstantFakeSession(mode: SessionMode, callOrder: string[]): InterpreterSession & {
  startCalls: LanguagePair[];
  stopCalls: number;
  emitTranscript: (update: TranscriptUpdate) => void;
  emitLatency: (report: LatencyReport) => void;
  emitNotice: (notice: SessionNotice) => void;
  /** Lets a test drive this fake straight to `'connected'` with no intervening `'connecting'` state, then simulate a mid-session death via `failMidSession`. */
  failMidSession: (message: string) => void;
} {
  let state: SessionState = { status: 'idle', errorMessage: null, errorKind: null, reconnectable: false };
  const stateListeners = new Set<(state: SessionState) => void>();
  const transcriptListeners = new Set<(update: TranscriptUpdate) => void>();
  const latencyListeners = new Set<(report: LatencyReport) => void>();
  const noticeListeners = new Set<(notice: SessionNotice) => void>();

  function setState(next: SessionState): void {
    state = next;
    for (const listener of stateListeners) listener(state);
  }

  const session = {
    mode,
    startCalls: [] as LanguagePair[],
    stopCalls: 0,
    getState: () => state,
    subscribe: (listener: (state: SessionState) => void) => {
      stateListeners.add(listener);
      listener(state);
      return () => stateListeners.delete(listener);
    },
    subscribeToTranscript: (listener: (update: TranscriptUpdate) => void) => {
      transcriptListeners.add(listener);
      return () => transcriptListeners.delete(listener);
    },
    subscribeToLatency: (listener: (report: LatencyReport) => void) => {
      latencyListeners.add(listener);
      return () => latencyListeners.delete(listener);
    },
    subscribeToNotice: (listener: (notice: SessionNotice) => void) => {
      noticeListeners.add(listener);
      return () => noticeListeners.delete(listener);
    },
    start: vi.fn(async (pair: LanguagePair) => {
      callOrder.push(`${mode}:start`);
      session.startCalls.push(pair);
      setState({ status: 'connecting', errorMessage: null, errorKind: null, reconnectable: false });
      setState({ status: 'connected', errorMessage: null, errorKind: null, reconnectable: false });
    }),
    stop: vi.fn(() => {
      callOrder.push(`${mode}:stop`);
      session.stopCalls += 1;
      setState({ status: 'idle', errorMessage: null, errorKind: null, reconnectable: false });
    }),
    emitTranscript: (update: TranscriptUpdate) => {
      for (const listener of transcriptListeners) listener(update);
    },
    emitLatency: (report: LatencyReport) => {
      for (const listener of latencyListeners) listener(report);
    },
    emitNotice: (notice: SessionNotice) => {
      for (const listener of noticeListeners) listener(notice);
    },
    failMidSession: (message: string) => {
      setState({ status: 'error', errorMessage: message, errorKind: null, reconnectable: true });
    },
  };
  return session;
}

describe('useInterpreterSession', () => {
  const PAIR: LanguagePair = { sourceLang: 'en', targetLang: 'es' };

  // Catches the bug where the toggle only takes effect on a later render (or not at
  // all) when no session is live yet: picking Cascade before pressing Start must
  // route the next Start to the Cascade transport, not silently keep using Realtime.
  it('routes Start to whichever transport is selected before any session begins', () => {
    const callOrder: string[] = [];
    const realtimeSession = createInstantFakeSession('realtime', callOrder);
    const cascadeSession = createInstantFakeSession('cascade', callOrder);
    const { result } = renderHook(() =>
      useInterpreterSession(PAIR, { realtime: realtimeSession, cascade: cascadeSession }),
    );

    act(() => result.current.setMode('cascade'));
    // Selecting a mode pre-session must not itself touch either transport.
    expect(realtimeSession.stopCalls).toBe(0);
    expect(cascadeSession.startCalls).toEqual([]);

    act(() => result.current.start());

    expect(cascadeSession.startCalls).toEqual([PAIR]);
    expect(realtimeSession.startCalls).toEqual([]);
    expect(result.current.mode).toBe('cascade');
    expect(result.current.status).toBe('connected');
  });

  // The core acceptance criterion from issue #9: toggling mid-conversation must stop
  // the active transport before starting the other — reversing that order (or
  // skipping the stop) is exactly how a mic track/socket/peer connection gets
  // orphaned when both transports are briefly live at once.
  it('stops the active transport before starting the other on a mid-session switch', async () => {
    const callOrder: string[] = [];
    const realtimeSession = createInstantFakeSession('realtime', callOrder);
    const cascadeSession = createInstantFakeSession('cascade', callOrder);
    const { result } = renderHook(() =>
      useInterpreterSession(PAIR, { realtime: realtimeSession, cascade: cascadeSession }),
    );

    act(() => result.current.start());
    expect(result.current.status).toBe('connected');
    callOrder.length = 0;

    act(() => result.current.setMode('cascade'));

    expect(callOrder).toEqual(['realtime:stop', 'cascade:start']);
    expect(result.current.mode).toBe('cascade');
  });

  // Catches the bug where a mid-session switch silently drops everything said so
  // far: the transcript is meant to survive a mode change (issue #9), not reset the
  // way a fresh top-level Start deliberately does.
  it('preserves transcript entries accumulated before a mid-session switch', () => {
    const callOrder: string[] = [];
    const realtimeSession = createInstantFakeSession('realtime', callOrder);
    const cascadeSession = createInstantFakeSession('cascade', callOrder);
    const { result } = renderHook(() =>
      useInterpreterSession(PAIR, { realtime: realtimeSession, cascade: cascadeSession }),
    );

    act(() => result.current.start());
    act(() =>
      realtimeSession.emitTranscript({ utteranceId: 'realtime:item_1', lane: 'source', text: 'Hola', final: true }),
    );
    expect(result.current.transcriptEntries).toEqual([
      { id: 'realtime:item_1', lane: 'source', text: 'Hola', final: true },
    ]);

    act(() => result.current.setMode('cascade'));

    expect(result.current.transcriptEntries).toEqual([
      { id: 'realtime:item_1', lane: 'source', text: 'Hola', final: true },
    ]);
  });

  // Catches the issue #10 requirement stated alongside #9's transcript-survival one:
  // latency reports must persist across a mid-session mode switch exactly like the
  // transcript does, not silently vanish when the transport changes.
  it('preserves latency reports accumulated before a mid-session switch', () => {
    const callOrder: string[] = [];
    const realtimeSession = createInstantFakeSession('realtime', callOrder);
    const cascadeSession = createInstantFakeSession('cascade', callOrder);
    const { result } = renderHook(() =>
      useInterpreterSession(PAIR, { realtime: realtimeSession, cascade: cascadeSession }),
    );

    act(() => result.current.start());
    act(() => realtimeSession.emitLatency({ utteranceId: 'realtime:turn-1', stages: [], endToEndMs: 1_200 }));
    expect(result.current.latencyReports).toEqual([{ utteranceId: 'realtime:turn-1', stages: [], endToEndMs: 1_200 }]);

    act(() => result.current.setMode('cascade'));

    expect(result.current.latencyReports).toEqual([{ utteranceId: 'realtime:turn-1', stages: [], endToEndMs: 1_200 }]);
  });

  // Catches the "reset on Start" requirement (issue #10): a fresh top-level Start must
  // clear the previous conversation's latency reports, mirroring the transcript reset
  // — otherwise a listener starting a brand-new call would see stale numbers from the
  // call before it.
  it('clears latency reports on a fresh top-level start()', () => {
    const callOrder: string[] = [];
    const realtimeSession = createInstantFakeSession('realtime', callOrder);
    const cascadeSession = createInstantFakeSession('cascade', callOrder);
    const { result } = renderHook(() =>
      useInterpreterSession(PAIR, { realtime: realtimeSession, cascade: cascadeSession }),
    );

    act(() => result.current.start());
    act(() => realtimeSession.emitLatency({ utteranceId: 'realtime:turn-1', stages: [], endToEndMs: 1_200 }));
    expect(result.current.latencyReports).toHaveLength(1);

    act(() => result.current.stop());
    act(() => result.current.start());

    expect(result.current.latencyReports).toEqual([]);
  });

  // Catches the bug where a mid-session switch negotiates the other transport with a
  // stale or default pair instead of whatever the listener actually had selected —
  // the whole point of carrying language state above both transports (issue #8/#9).
  it('starts the new transport with the same language pair the old one was using', () => {
    const callOrder: string[] = [];
    const realtimeSession = createInstantFakeSession('realtime', callOrder);
    const cascadeSession = createInstantFakeSession('cascade', callOrder);
    const pair: LanguagePair = { sourceLang: 'es', targetLang: 'fr' };
    const { result } = renderHook(() =>
      useInterpreterSession(pair, { realtime: realtimeSession, cascade: cascadeSession }),
    );

    act(() => result.current.start());
    act(() => result.current.setMode('cascade'));

    expect(cascadeSession.startCalls).toEqual([pair]);
  });

  // Catches the bug where the "switching..." indicator either never appears (so a
  // listener sees no feedback while the new transport connects) or never clears
  // once the new transport has actually settled.
  it('reports switching while a mid-session mode change is in flight, then clears it once the new transport settles', async () => {
    const callOrder: string[] = [];
    const realtimeSession = createInstantFakeSession('realtime', callOrder);
    let resolveCascadeStart!: () => void;
    // `getState`/`subscribe` must hand back a stable reference until the state actually
    // changes — same contract the real controllers uphold — otherwise useSyncExternalStore
    // sees a "new" snapshot on every render and loops forever.
    const idleState: SessionState = { status: 'idle', errorMessage: null, errorKind: null, reconnectable: false };
    const cascadeSession: InterpreterSession = {
      mode: 'cascade',
      getState: () => idleState,
      subscribe: (listener) => {
        listener(idleState);
        return () => {};
      },
      subscribeToTranscript: () => () => {},
      start: () =>
        new Promise<void>((resolve) => {
          resolveCascadeStart = resolve;
        }),
      stop: () => {},
    };
    const { result } = renderHook(() =>
      useInterpreterSession(PAIR, { realtime: realtimeSession, cascade: cascadeSession }),
    );

    act(() => result.current.start());
    act(() => result.current.setMode('cascade'));

    expect(result.current.switching).toBe(true);

    await act(async () => {
      resolveCascadeStart();
      await Promise.resolve();
    });

    expect(result.current.switching).toBe(false);
  });

  // Catches the bug where selecting the mode that's already active mid-session tears
  // the live transport down and immediately restarts it for no reason, needlessly
  // interrupting an already-working session.
  it('does nothing when the already-active mode is selected again', () => {
    const callOrder: string[] = [];
    const realtimeSession = createInstantFakeSession('realtime', callOrder);
    const cascadeSession = createInstantFakeSession('cascade', callOrder);
    const { result } = renderHook(() =>
      useInterpreterSession(PAIR, { realtime: realtimeSession, cascade: cascadeSession }),
    );

    act(() => result.current.start());
    callOrder.length = 0;

    act(() => result.current.setMode('realtime'));

    expect(callOrder).toEqual([]);
    expect(realtimeSession.stopCalls).toBe(0);
  });

  // Catches the bug where a per-stage cascade notice (issue #12) either never
  // reaches the UI, or gets dropped/duplicated on its way through the hook.
  it('surfaces a notice emitted by the active session', () => {
    const callOrder: string[] = [];
    const realtimeSession = createInstantFakeSession('realtime', callOrder);
    const cascadeSession = createInstantFakeSession('cascade', callOrder);
    const { result } = renderHook(() =>
      useInterpreterSession(PAIR, { realtime: realtimeSession, cascade: cascadeSession }),
    );

    act(() => result.current.start());
    act(() => realtimeSession.emitNotice({ id: 'notice_1', message: 'Machine translation failed for one utterance.' }));

    expect(result.current.notice).toEqual({ id: 'notice_1', message: 'Machine translation failed for one utterance.' });
  });

  // Catches the bug where dismissing a notice doesn't actually clear it, leaving a
  // listener unable to get rid of a strip they've already acknowledged.
  it('clears the notice when dismissNotice is called', () => {
    const callOrder: string[] = [];
    const realtimeSession = createInstantFakeSession('realtime', callOrder);
    const cascadeSession = createInstantFakeSession('cascade', callOrder);
    const { result } = renderHook(() =>
      useInterpreterSession(PAIR, { realtime: realtimeSession, cascade: cascadeSession }),
    );

    act(() => result.current.start());
    act(() => realtimeSession.emitNotice({ id: 'notice_1', message: 'Machine translation failed for one utterance.' }));
    expect(result.current.notice).not.toBeNull();

    act(() => result.current.dismissNotice());

    expect(result.current.notice).toBeNull();
  });

  // Catches the core issue #12 acceptance criterion: reconnecting after a
  // mid-session death must preserve everything said so far — a listener who just
  // watched the transport die shouldn't also lose the conversation transcript,
  // the way a brand-new top-level Start deliberately clears it.
  it('preserves transcript entries across reconnect(), unlike a fresh start()', () => {
    const callOrder: string[] = [];
    const realtimeSession = createInstantFakeSession('realtime', callOrder);
    const cascadeSession = createInstantFakeSession('cascade', callOrder);
    const { result } = renderHook(() =>
      useInterpreterSession(PAIR, { realtime: realtimeSession, cascade: cascadeSession }),
    );

    act(() => result.current.start());
    act(() =>
      realtimeSession.emitTranscript({ utteranceId: 'realtime:item_1', lane: 'source', text: 'Hola', final: true }),
    );
    act(() => realtimeSession.failMidSession('The realtime connection was lost.'));
    expect(result.current.status).toBe('error');
    expect(result.current.reconnectable).toBe(true);
    callOrder.length = 0;

    act(() => result.current.reconnect());

    // stop() before start() — exactly like setMode's mid-session branch — so the dead
    // transport's resources are fully released before a fresh one is requested.
    expect(callOrder).toEqual(['realtime:stop', 'realtime:start']);
    // Two calls total: the original start() earlier in this test, plus reconnect()'s.
    expect(realtimeSession.startCalls).toEqual([PAIR, PAIR]);
    expect(result.current.transcriptEntries).toEqual([
      { id: 'realtime:item_1', lane: 'source', text: 'Hola', final: true },
    ]);
  });

  // Catches a stale-notice bug: reconnecting from a mid-session death should clear
  // whatever notice was showing beforehand, the same way a fresh start() does — an
  // old per-stage notice lingering past a Reconnect would misleadingly suggest it's
  // still relevant to the new connection.
  it('clears any pending notice on reconnect()', () => {
    const callOrder: string[] = [];
    const realtimeSession = createInstantFakeSession('realtime', callOrder);
    const cascadeSession = createInstantFakeSession('cascade', callOrder);
    const { result } = renderHook(() =>
      useInterpreterSession(PAIR, { realtime: realtimeSession, cascade: cascadeSession }),
    );

    act(() => result.current.start());
    act(() => realtimeSession.emitNotice({ id: 'notice_1', message: 'Machine translation failed for one utterance.' }));
    act(() => realtimeSession.failMidSession('The realtime connection was lost.'));

    act(() => result.current.reconnect());

    expect(result.current.notice).toBeNull();
  });
});
