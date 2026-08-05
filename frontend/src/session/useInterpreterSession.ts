import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import {
  reportConversationMetrics,
  type CascadeStageModels,
  type ConversationMetricsPayload,
  type LanguagePair,
} from '../api';
import { latencyReducer, selectLatencyAverages, selectRecentReports } from '../latency/latencyReducer';
import { INITIAL_LATENCY_STATE, type LatencyReport, type LatencySessionAverages, type LatencyState } from '../latency/types';
import { transcriptReducer } from '../transcript/transcriptReducer';
import {
  INITIAL_TRANSCRIPT_STATE,
  type TranscriptEntry,
  type TranscriptState,
  type TranscriptUpdate,
} from '../transcript/types';
import { CascadeInterpreterSession } from './CascadeInterpreterSession';
import {
  isLiveStatus,
  modeOfPrefixedId,
  type InterpreterSession,
  type SessionErrorKind,
  type SessionMode,
  type SessionNotice,
  type SessionStatus,
} from './InterpreterSession';
import { RealtimeInterpreterSession } from './RealtimeInterpreterSession';

/** Wraps the pure `transcriptReducer` with a `reset` action for "a fresh Start clears the previous conversation's transcript". */
type TranscriptAction = { kind: 'reset' } | { kind: 'update'; update: TranscriptUpdate };

function reduceTranscript(state: TranscriptState, action: TranscriptAction): TranscriptState {
  return action.kind === 'reset' ? INITIAL_TRANSCRIPT_STATE : transcriptReducer(state, action.update);
}

/**
 * Wraps the pure `latencyReducer` with a `reset` action, mirroring
 * `reduceTranscript` exactly — a fresh Start clears the previous
 * conversation's latency reports (issue #10), same as it clears the
 * transcript, while a mid-session mode switch (`setMode`) never dispatches
 * `reset`, so both survive across a mode switch identically.
 */
type LatencyAction = { kind: 'reset' } | { kind: 'report'; report: LatencyReport };

function reduceLatency(state: LatencyState, action: LatencyAction): LatencyState {
  return action.kind === 'reset' ? INITIAL_LATENCY_STATE : latencyReducer(state, action.report);
}

export interface UseInterpreterSessionResult {
  /** The transport the toggle currently has selected. */
  mode: SessionMode;
  status: SessionStatus;
  /** Human-readable failure reason, set only when `status` is `'error'`. */
  errorMessage: string | null;
  /** See `SessionState.errorKind` (issue #12) — narrows *why* `status` is `'error'` for the mic-permission cases shared UI renders distinctly. `null` otherwise. */
  errorKind: SessionErrorKind;
  /** See `SessionState.reconnectable` (issue #12) — true when recovering means the Reconnect affordance (`reconnect()`, preserving transcript) rather than a plain `start()` retry. */
  reconnectable: boolean;
  /** True while a mid-session mode switch is tearing the old transport down and bringing the new one up. */
  switching: boolean;
  /** Live source/target transcript entries for this conversation, preserved across mode switches. */
  transcriptEntries: TranscriptEntry[];
  /** The most recently appeared utterances' latency breakdowns (issue #10), preserved across mode switches like `transcriptEntries`. */
  latencyReports: LatencyReport[];
  /** Per-mode running latency averages — each mode's population judged against its own target by the scoreboard, never blended. */
  latencyAveragesByMode: Record<SessionMode, LatencySessionAverages>;
  /** The latest non-fatal, dismissible per-stage notice (issue #12), or `null` once dismissed/superseded/cleared by a fresh `start()`/`reconnect()`/mode switch. */
  notice: SessionNotice | null;
  /**
   * Selects the given transport. Pre-session (or once a session has settled
   * into `'error'`), this just changes which transport the next `start()`
   * uses. Mid-session (status is `'requesting-mic'`, `'connecting'`, or
   * `'connected'`), this instead stops the active transport and starts the
   * other one with the same language pair, surfacing `switching: true` for
   * the duration.
   */
  setMode: (mode: SessionMode) => void;
  /** Requests mic access and opens the currently selected transport, clearing any previous conversation's transcript. */
  start: () => void;
  /** Tears the active transport down cleanly (safe to call from any state). */
  stop: () => void;
  /**
   * The Reconnect affordance (issue #12): tears the active transport down and
   * starts a fresh one with the same language pair, *without* clearing
   * transcript/latency history — unlike `start()`, which is always a
   * deliberate fresh conversation. Meant to be called only while
   * `reconnectable` is true (a dead mid-session transport), mirroring how
   * `setMode`'s mid-session branch stops-then-starts without resetting.
   */
  reconnect: () => void;
  /** Dismisses the current `notice`, if any. */
  dismissNotice: () => void;
}

/** Builds one long-lived `InterpreterSession` per mode, backed by the real Realtime/Cascade adapters. */
function defaultSessions(): Record<SessionMode, InterpreterSession> {
  return {
    realtime: new RealtimeInterpreterSession(),
    cascade: new CascadeInterpreterSession(),
  };
}

/**
 * React binding for the mode toggle (issue #9): owns one `InterpreterSession`
 * per {@link SessionMode} for its whole lifetime and exposes only the
 * currently *active* one's state/transcript through the shared,
 * mode-agnostic surface the UI consumes — `SessionPanel` never imports either
 * adapter or controller directly.
 *
 * Transcript history lives here, above both transports, specifically so it
 * survives a mode switch: `setMode`'s mid-session branch never dispatches a
 * `reset` action (only the top-level `start()` does, for "a fresh Start
 * clears the previous conversation"), and each adapter namespaces its own
 * `utteranceId`s (`prefixUtteranceId`, applied inside
 * `RealtimeInterpreterSession`/`CascadeInterpreterSession`) so entries from
 * the two transports can never collide in this shared list.
 *
 * Both never-started sessions are stopped on unmount, mirroring
 * `useRealtimeSession`/`useCascadeSession`'s teardown discipline so
 * navigating away mid-call can't leak a live mic track, socket, or peer
 * connection regardless of which mode was active.
 *
 * @param pair - Source/target language pair `start()` and a mid-session mode
 *   switch both negotiate with (issue #8). Read fresh via a ref on every
 *   switch, so the pair selected before Start — or before toggling modes —
 *   carries across without needing to recreate this hook.
 * @param sessions - Overridable for tests (two fake `InterpreterSession`s);
 *   production callers should omit this and get the real adapters.
 */
export function useInterpreterSession(
  pair: LanguagePair,
  sessions?: Record<SessionMode, InterpreterSession>,
  cascadeModels?: CascadeStageModels,
): UseInterpreterSessionResult {
  const sessionsRef = useRef<Record<SessionMode, InterpreterSession> | null>(null);
  sessionsRef.current ??= sessions ?? defaultSessions();
  const activeSessions = sessionsRef.current;

  const [mode, setModeState] = useState<SessionMode>('realtime');
  const [switching, setSwitching] = useState(false);
  const pairRef = useRef(pair);
  pairRef.current = pair;
  const cascadeModelsRef = useRef(cascadeModels);
  cascadeModelsRef.current = cascadeModels;

  /** Pushes the current stage picks into a session that takes them (cascade), right before any start. */
  function applyStageModels(session: InterpreterSession): void {
    session.setStageModels?.(cascadeModelsRef.current ?? {});
  }

  const activeSession = activeSessions[mode];

  // Memoized (keyed on the active session, the only thing it closes over
  // that ever actually changes) so useSyncExternalStore sees a stable
  // `subscribe` reference across re-renders — otherwise it treats every
  // render as a potentially-different store and tears down/re-subscribes on
  // each one instead of only when the transport itself changes.
  const subscribeToActiveSession = useCallback(
    (onStoreChange: () => void) => activeSession.subscribe(() => onStoreChange()),
    [activeSession],
  );
  const state = useSyncExternalStore(subscribeToActiveSession, () => activeSession.getState());

  const [transcriptState, dispatchTranscript] = useReducer(reduceTranscript, INITIAL_TRANSCRIPT_STATE);
  const [latencyState, dispatchLatency] = useReducer(reduceLatency, INITIAL_LATENCY_STATE);
  const [notice, setNotice] = useState<SessionNotice | null>(null);

  // One conversation per Start press (issue #10 revisited): the id/start-time/pair
  // captured when the user starts, kept in a ref because nothing renders from them.
  // Survives mode switches and reconnects — like the transcript/latency history it
  // labels, it is scoped to the *conversation*, not to any one transport session.
  const conversationRef = useRef<{ id: string; startedAtMs: number; pair: LanguagePair } | null>(null);

  /**
   * Posts the conversation's accumulated latency reports and transcript for
   * persistence. Fire-and-forget by design: metrics capture must never delay or
   * break session teardown, so a failed post is logged and dropped. Safe to call
   * repeatedly — the backend upserts on the conversation id, so a double Stop
   * press replaces the stored report rather than duplicating it.
   */
  function reportConversation(): void {
    const conversation = conversationRef.current;
    // Nothing captured (Stop before any utterance, or Stop pressed twice after a
    // fresh Start) — an all-empty report would only clutter the store.
    if (conversation === null || (latencyState.reports.length === 0 && transcriptState.entries.length === 0)) {
      return;
    }

    const models = cascadeModelsRef.current ?? {};
    const payload: ConversationMetricsPayload = {
      conversationId: conversation.id,
      sourceLang: conversation.pair.sourceLang,
      targetLang: conversation.pair.targetLang,
      startedAtMs: conversation.startedAtMs,
      endedAtMs: Date.now(),
      ...(models.sttModel ? { sttModel: models.sttModel } : {}),
      ...(models.mtProvider ? { mtProvider: models.mtProvider } : {}),
      utterances: latencyState.reports.map((report) => ({
        utteranceId: report.utteranceId,
        mode: modeOfPrefixedId(report.utteranceId),
        endToEndMs: report.endToEndMs,
        stages: report.stages.map(({ stage, ms }) => ({ stage, ms })),
      })),
      transcript: transcriptState.entries.map((entry) => ({
        utteranceId: entry.id,
        lane: entry.lane,
        text: entry.text,
        final: entry.final,
        ...(entry.truncated ? { truncated: true } : {}),
      })),
    };

    void reportConversationMetrics(payload).catch((error: unknown) => {
      console.warn('Failed to persist session metrics; the session itself is unaffected.', error);
    });
  }

  useEffect(() => {
    return activeSession.subscribeToTranscript((update) => dispatchTranscript({ kind: 'update', update }));
  }, [activeSession]);

  useEffect(() => {
    return activeSession.subscribeToLatency?.((report) => dispatchLatency({ kind: 'report', report }));
  }, [activeSession]);

  // Issue #12: a notice is scoped to the session that produced it — a fresh
  // Start, a Reconnect, or switching which transport is active should never
  // leave a stale one from a previous conversation on screen.
  useEffect(() => {
    setNotice(null);
    return activeSession.subscribeToNotice?.((next) => setNotice(next));
  }, [activeSession]);

  useEffect(() => {
    return () => {
      activeSessions.realtime.stop();
      activeSessions.cascade.stop();
    };
  }, [activeSessions]);

  /**
   * Mid-session sequencing matters: `current.stop()` fully releases the old
   * transport's mic track/socket/peer connection *before* `next.start()`
   * requests a fresh mic stream, so the two transports are never live at
   * once and nothing is orphaned. `switching` clears once `start()` settles
   * (it never rejects — both controllers catch their own failures into an
   * `'error'` state and resolve normally), whether the new transport landed
   * on `'connected'` or `'error'`.
   */
  function setMode(nextMode: SessionMode): void {
    if (nextMode === mode || switching) return;

    const current = activeSessions[mode];
    if (!isLiveStatus(current.getState().status)) {
      setModeState(nextMode);
      return;
    }

    setSwitching(true);
    current.stop();
    setModeState(nextMode);
    const next = activeSessions[nextMode];
    applyStageModels(next);
    void next.start(pairRef.current).finally(() => setSwitching(false));
  }

  // Keyed on latencyState so these only recompute when a new report actually
  // lands, rather than deriving a fresh array/object (and so a fresh
  // reference) on every render regardless of whether latencyState changed —
  // which would otherwise defeat any downstream `React.memo`/dependency
  // array keyed on these values.
  const latencyReports = useMemo(() => selectRecentReports(latencyState), [latencyState]);
  const latencyAveragesByMode = useMemo(
    () => ({
      realtime: selectLatencyAverages(latencyState, (report) => modeOfPrefixedId(report.utteranceId) === 'realtime'),
      cascade: selectLatencyAverages(latencyState, (report) => modeOfPrefixedId(report.utteranceId) === 'cascade'),
    }),
    [latencyState],
  );

  return {
    mode,
    status: state.status,
    errorMessage: state.errorMessage,
    errorKind: state.errorKind,
    reconnectable: state.reconnectable,
    switching,
    transcriptEntries: transcriptState.entries,
    latencyReports,
    latencyAveragesByMode,
    notice,
    setMode,
    start: () => {
      conversationRef.current = { id: crypto.randomUUID(), startedAtMs: Date.now(), pair };
      dispatchTranscript({ kind: 'reset' });
      dispatchLatency({ kind: 'reset' });
      setNotice(null);
      applyStageModels(activeSession);
      void activeSession.start(pair);
    },
    // Stop is the persistence point (issue #10 revisited): the user deliberately
    // ending the conversation is the one moment its accumulated history is complete.
    // Reconnect and mode switches don't report — the conversation isn't over yet —
    // and unmount teardown doesn't either (nothing to render the result into, and
    // benchmark sessions end with Stop, not navigation).
    stop: () => {
      reportConversation();
      activeSession.stop();
    },
    // Deliberately mirrors setMode's mid-session branch: stop() fully
    // releases the dead transport's resources before start() requests a
    // fresh mic stream, and neither transcript nor latency history is reset
    // — this is "the same conversation, transport came back", not a new one.
    reconnect: () => {
      activeSession.stop();
      setNotice(null);
      applyStageModels(activeSession);
      void activeSession.start(pairRef.current);
    },
    dismissNotice: () => setNotice(null),
  };
}
