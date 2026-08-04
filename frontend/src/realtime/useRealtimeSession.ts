import { useEffect, useRef } from 'react';
import { useSyncExternalStore } from 'react';
import { RealtimeSessionController } from './RealtimeSessionController';
import type { RealtimeSessionState } from './types';

export interface UseRealtimeSessionResult extends RealtimeSessionState {
  /** Requests mic access and opens the WebRTC session. */
  start: () => void;
  /** Tears the session down cleanly (safe to call from any state). */
  stop: () => void;
}

/**
 * React binding for {@link RealtimeSessionController}: re-renders the
 * component on every state change and tears the session down on unmount, so
 * navigating away mid-call can't leak a live mic track or peer connection.
 *
 * Exposes only the small `RealtimeSessionState` interface plus `start`/`stop`
 * — no transport (SDP, RTCPeerConnection, data channel) leaks to the caller,
 * keeping consuming UI mode-agnostic.
 */
export function useRealtimeSession(): UseRealtimeSessionResult {
  const controllerRef = useRef<RealtimeSessionController | null>(null);
  controllerRef.current ??= new RealtimeSessionController();
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
