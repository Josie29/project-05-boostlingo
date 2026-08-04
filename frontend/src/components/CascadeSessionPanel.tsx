import { useEffect } from 'react';
import { useCascadeSession } from '../cascade/useCascadeSession';
import type { CascadeSessionStatus } from '../cascade/types';
import { DEFAULT_LANGUAGE_PAIR, type LanguagePair } from '../api';
import { TranscriptPanel } from './TranscriptPanel';

const STATUS_LABEL: Record<CascadeSessionStatus, string> = {
  idle: 'Idle',
  'requesting-mic': 'Requesting microphone...',
  connecting: 'Connecting...',
  connected: 'Connected',
  error: 'Error',
};

export interface CascadeSessionPanelProps {
  /** Source/target pair to negotiate on Start (issue #8); falls back to the backend's own en -> es default if omitted. */
  pair?: LanguagePair;
  /** Called whenever this panel's session becomes active/inactive, so a shared language selector can disable itself mid-session. */
  onActiveChange?: (active: boolean) => void;
}

/**
 * Start/Stop control for a Cascade (STT -> MT -> TTS) interpreter session.
 * Negotiates whatever source/target pair the shared `LanguagePairSelector`
 * has selected (issue #8), defaulting to English -> Spanish if none was
 * passed in. Renders the live STT transcript in the source column and the
 * live MT (Machine Translation) transcript in the target column as soon as
 * each arrives (issues #5-6); the target lane's synthesized speech plays
 * back automatically through `useCascadeSession`'s `AudioPlaybackQueue` as
 * soon as audio for an utterance starts streaming in (issue #7) — nothing
 * to render for that, since it's just sound.
 *
 * Contains no transport logic itself — all WebSocket/AudioWorklet/Web Audio
 * state lives in `useCascadeSession`, mirroring `RealtimeSessionPanel`'s
 * shape so the two modes are easy to compare side by side.
 */
export function CascadeSessionPanel({ pair = DEFAULT_LANGUAGE_PAIR, onActiveChange }: CascadeSessionPanelProps = {}) {
  const { status, errorMessage, start, stop, transcriptEntries } = useCascadeSession(pair);

  const isBusy = status === 'requesting-mic' || status === 'connecting';
  const isConnected = status === 'connected';

  useEffect(() => {
    onActiveChange?.(isBusy || isConnected);
  }, [isBusy, isConnected, onActiveChange]);

  return (
    <section className="cascade-session" aria-label="Cascade pipeline session">
      <p className="cascade-session__status" data-status={status}>
        <span className="cascade-session__dot" aria-hidden="true" />
        {STATUS_LABEL[status]}
      </p>

      {status === 'error' && errorMessage && (
        <p className="cascade-session__error" role="alert">
          {errorMessage}
        </p>
      )}

      <div className="cascade-session__controls">
        <button type="button" onClick={start} disabled={isBusy || isConnected}>
          Start
        </button>
        <button type="button" onClick={stop} disabled={status === 'idle'}>
          Stop
        </button>
      </div>

      <TranscriptPanel entries={transcriptEntries} />
    </section>
  );
}
