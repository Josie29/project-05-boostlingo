import { useEffect, useRef, useSyncExternalStore } from 'react';
import { CascadeSessionController } from './CascadeSessionController';
import type { CascadeSessionState } from './types';

export interface UseCascadeSessionResult extends CascadeSessionState {
  /** Requests mic access and opens the cascade WebSocket session. */
  start: () => void;
  /** Tears the session down cleanly (safe to call from any state). */
  stop: () => void;
}

/**
 * React binding for {@link CascadeSessionController}: re-renders the
 * component on every state change and tears the session down on unmount, so
 * navigating away mid-session can't leak a live mic track, AudioContext, or
 * open WebSocket.
 *
 * Exposes only the small `CascadeSessionState` interface plus `start`/`stop`
 * — no WebSocket, AudioContext, or envelope detail leaks to the caller,
 * mirroring `useRealtimeSession`'s shape.
 */
export function useCascadeSession(): UseCascadeSessionResult {
  const controllerRef = useRef<CascadeSessionController | null>(null);
  controllerRef.current ??= new CascadeSessionController();
  const controller = controllerRef.current;

  const state = useSyncExternalStore(
    (onStoreChange) => controller.subscribe(() => onStoreChange()),
    () => controller.getState(),
  );

  useEffect(() => {
    return () => controller.stop();
  }, [controller]);

  return {
    ...state,
    start: () => void controller.start(),
    stop: () => controller.stop(),
  };
}
