import { useEffect, useReducer, useRef, useSyncExternalStore } from 'react';
import { AudioPlaybackQueue } from './AudioPlaybackQueue';
import { CascadeSessionController } from './CascadeSessionController';
import { mapCascadeEventToTranscriptUpdate } from './cascadeTranscriptAdapter';
import type { CascadeSessionState } from './types';
import type { LanguagePair } from '../api';
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
 *
 * Also owns an `AudioPlaybackQueue`, fed by `controller.subscribeToAudio`,
 * which plays the target-lane TTS (Text-to-Speech) audio for each utterance
 * as it streams in (issue #7). The queue is stopped alongside the
 * controller — both on an explicit `stop()` and on unmount — so leaving the
 * page or hitting Stop mid-utterance silences audio immediately rather than
 * letting already-scheduled chunks keep playing out.
 *
 * @param pair - Source/target language pair `start()` negotiates in the
 *   `session.start` handshake (issue #8). Read fresh on every call, so
 *   selecting a new pair before Start is pressed uses the latest choice;
 *   changing it mid-session is out of scope here.
 */
export function useCascadeSession(pair?: LanguagePair): UseCascadeSessionResult {
  const controllerRef = useRef<CascadeSessionController | null>(null);
  controllerRef.current ??= new CascadeSessionController();
  const controller = controllerRef.current;

  const playbackQueueRef = useRef<AudioPlaybackQueue | null>(null);
  playbackQueueRef.current ??= new AudioPlaybackQueue();
  const playbackQueue = playbackQueueRef.current;

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
    return controller.subscribeToAudio((event) => playbackQueue.handleEvent(event));
  }, [controller, playbackQueue]);

  useEffect(() => {
    return () => {
      controller.stop();
      void playbackQueue.stop();
    };
  }, [controller, playbackQueue]);

  return {
    ...state,
    transcriptEntries: transcriptState.entries,
    start: () => {
      dispatchTranscript({ kind: 'reset' });
      void controller.start(pair);
    },
    stop: () => {
      controller.stop();
      void playbackQueue.stop();
    },
  };
}
