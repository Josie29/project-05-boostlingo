import { useEffect, useReducer, useRef, useSyncExternalStore } from 'react';
import { CascadeSessionController } from './CascadeSessionController';
import { mapCascadeEventToTranscriptUpdate } from './cascadeTranscriptAdapter';
import type { CascadeSessionState } from './types';
import { transcriptReducer } from '../transcript/transcriptReducer';
import {
  INITIAL_TRANSCRIPT_STATE,
  type TranscriptEntry,
  type TranscriptState,
  type TranscriptUpdate,
} from '../transcript/types';

/** Wraps the pure `transcriptReducer` with a `reset` action for "a fresh Start clears the previous session's transcript". */
type TranscriptAction = { kind: 'reset' } | { kind: 'update'; update: TranscriptUpdate };

function reduceTranscript(state: TranscriptState, action: TranscriptAction): TranscriptState {
  return action.kind === 'reset' ? INITIAL_TRANSCRIPT_STATE : transcriptReducer(state, action.update);
}

export interface UseCascadeSessionResult extends CascadeSessionState {
  /** Requests mic access and opens the cascade WebSocket session. */
  start: () => void;
  /** Tears the session down cleanly (safe to call from any state). */
  stop: () => void;
  /** Live source/target transcript entries for this session, mode-agnostic — feeds `TranscriptPanel` directly. */
  transcriptEntries: TranscriptEntry[];
}

/**
 * React binding for {@link CascadeSessionController}: re-renders the
 * component on every state change and tears the session down on unmount, so
 * navigating away mid-session can't leak a live mic track, AudioContext, or
 * open WebSocket.
 *
 * Exposes only the small `CascadeSessionState` interface plus `start`/`stop`
 * and the mode-agnostic `transcriptEntries` — no WebSocket, AudioContext, or
 * envelope detail leaks to the caller, mirroring `useRealtimeSession`'s
 * shape. Cascade WebSocket envelopes are translated into transcript entries
 * via `cascadeTranscriptAdapter` + `transcriptReducer`; `transcriptEntries`
 * resets to empty every time `start()` is called, so a new session doesn't
 * show stale text from the previous one.
 */
export function useCascadeSession(): UseCascadeSessionResult {
  const controllerRef = useRef<CascadeSessionController | null>(null);
  controllerRef.current ??= new CascadeSessionController();
  const controller = controllerRef.current;

  const state = useSyncExternalStore(
    (onStoreChange) => controller.subscribe(() => onStoreChange()),
    () => controller.getState(),
  );

  const [transcriptState, dispatchTranscript] = useReducer(reduceTranscript, INITIAL_TRANSCRIPT_STATE);

  useEffect(() => {
    return controller.subscribeToEvents((event) => {
      const update = mapCascadeEventToTranscriptUpdate(event);
      if (update) dispatchTranscript({ kind: 'update', update });
    });
  }, [controller]);

  useEffect(() => {
    return () => controller.stop();
  }, [controller]);

  return {
    ...state,
    transcriptEntries: transcriptState.entries,
    start: () => {
      dispatchTranscript({ kind: 'reset' });
      void controller.start();
    },
    stop: () => controller.stop(),
  };
}
