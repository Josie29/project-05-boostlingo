import { useEffect, useReducer, useRef } from 'react';
import { useSyncExternalStore } from 'react';
import { RealtimeSessionController } from './RealtimeSessionController';
import { mapRealtimeEventToTranscriptUpdate } from './realtimeTranscriptAdapter';
import type { RealtimeSessionState } from './types';
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

export interface UseRealtimeSessionResult extends RealtimeSessionState {
  /** Requests mic access and opens the WebRTC session. */
  start: () => void;
  /** Tears the session down cleanly (safe to call from any state). */
  stop: () => void;
  /** Live source/target transcript entries for this session, mode-agnostic — feeds `TranscriptPanel` directly. */
  transcriptEntries: TranscriptEntry[];
}

/**
 * React binding for {@link RealtimeSessionController}: re-renders the
 * component on every state change and tears the session down on unmount, so
 * navigating away mid-call can't leak a live mic track or peer connection.
 *
 * Exposes only the small `RealtimeSessionState` interface plus `start`/`stop`
 * and the mode-agnostic `transcriptEntries` — no transport (SDP,
 * RTCPeerConnection, data channel, or OpenAI event shapes) leaks to the
 * caller, keeping consuming UI mode-agnostic. Data-channel events are
 * translated into transcript entries via `realtimeTranscriptAdapter` +
 * `transcriptReducer`; `transcriptEntries` resets to empty every time
 * `start()` is called, so a new session doesn't show stale text from the
 * previous one.
 */
export function useRealtimeSession(): UseRealtimeSessionResult {
  const controllerRef = useRef<RealtimeSessionController | null>(null);
  controllerRef.current ??= new RealtimeSessionController();
  const controller = controllerRef.current;

  const state = useSyncExternalStore(
    (onStoreChange) => controller.subscribe(() => onStoreChange()),
    () => controller.getState(),
  );

  const [transcriptState, dispatchTranscript] = useReducer(reduceTranscript, INITIAL_TRANSCRIPT_STATE);

  useEffect(() => {
    return controller.subscribeToEvents((event) => {
      const update = mapRealtimeEventToTranscriptUpdate(event);
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
