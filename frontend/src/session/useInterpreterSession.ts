import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import type { LanguagePair } from '../api';
import { transcriptReducer } from '../transcript/transcriptReducer';
import {
  INITIAL_TRANSCRIPT_STATE,
  type TranscriptEntry,
  type TranscriptState,
  type TranscriptUpdate,
} from '../transcript/types';
import { CascadeInterpreterSession } from './CascadeInterpreterSession';
import { isLiveStatus, type InterpreterSession, type SessionMode, type SessionStatus } from './InterpreterSession';
import { RealtimeInterpreterSession } from './RealtimeInterpreterSession';

/** Wraps the pure `transcriptReducer` with a `reset` action for "a fresh Start clears the previous conversation's transcript". */
type TranscriptAction = { kind: 'reset' } | { kind: 'update'; update: TranscriptUpdate };

function reduceTranscript(state: TranscriptState, action: TranscriptAction): TranscriptState {
  return action.kind === 'reset' ? INITIAL_TRANSCRIPT_STATE : transcriptReducer(state, action.update);
}

export interface UseInterpreterSessionResult {
  /** The transport the toggle currently has selected. */
  mode: SessionMode;
  status: SessionStatus;
  /** Human-readable failure reason, set only when `status` is `'error'`. */
  errorMessage: string | null;
  /** True while a mid-session mode switch is tearing the old transport down and bringing the new one up. */
  switching: boolean;
  /** Live source/target transcript entries for this conversation, preserved across mode switches. */
  transcriptEntries: TranscriptEntry[];
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
): UseInterpreterSessionResult {
  const sessionsRef = useRef<Record<SessionMode, InterpreterSession> | null>(null);
  sessionsRef.current ??= sessions ?? defaultSessions();
  const activeSessions = sessionsRef.current;

  const [mode, setModeState] = useState<SessionMode>('realtime');
  const [switching, setSwitching] = useState(false);
  const pairRef = useRef(pair);
  pairRef.current = pair;

  const activeSession = activeSessions[mode];

  const state = useSyncExternalStore(
    (onStoreChange) => activeSession.subscribe(() => onStoreChange()),
    () => activeSession.getState(),
  );

  const [transcriptState, dispatchTranscript] = useReducer(reduceTranscript, INITIAL_TRANSCRIPT_STATE);

  useEffect(() => {
    return activeSession.subscribeToTranscript((update) => dispatchTranscript({ kind: 'update', update }));
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
    void next.start(pairRef.current).finally(() => setSwitching(false));
  }

  return {
    mode,
    status: state.status,
    errorMessage: state.errorMessage,
    switching,
    transcriptEntries: transcriptState.entries,
    setMode,
    start: () => {
      dispatchTranscript({ kind: 'reset' });
      void activeSession.start(pair);
    },
    stop: () => activeSession.stop(),
  };
}
