import { MIC_AUDIO_CONSTRAINTS } from '../audio/micConstraints';
import { MicAccessError, wrapMicError } from '../audio/micErrors';
import type { SessionErrorKind, SessionStatus } from './sessionState';

/**
 * Hooks a transport controller hands to {@link runSessionStart}. Everything
 * here is a thin closure over controller internals; the only genuinely
 * transport-specific work is {@link connect}.
 */
export interface SessionStartHooks {
  /** Session status at the moment `start()` was called, for the already-live no-op guard. */
  status: SessionStatus;
  /** Bumps and returns the controller's start/stop generation counter. */
  bumpGeneration(): number;
  /**
   * True while `generation` is still the controller's current one — false
   * once a later `start()`/`stop()` superseded this attempt, at which point
   * the scaffold stops touching controller state entirely.
   */
  isCurrent(generation: number): boolean;
  /** The controller's own state setter; signature shared via {@link SessionStatus}/{@link SessionErrorKind}. */
  setState(
    status: SessionStatus,
    errorMessage?: string | null,
    errorKind?: SessionErrorKind,
    reconnectable?: boolean,
  ): void;
  /** Mic acquisition seam (DI'd in tests). */
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  /** Stores the acquired mic stream on the controller before connecting, so `teardown` can release it. */
  storeStream(stream: MediaStream): void;
  /**
   * Transport-specific connect, run between `'connecting'` and
   * `'connected'`. Receives `generation` so multi-step connects can do their
   * own staleness checks between awaits; a throw lands in the shared
   * error-classification catch below.
   */
  connect(stream: MediaStream, generation: number): Promise<void>;
  /** Releases transport resources after a failed start. */
  teardown(): void;
  /** Error message used when a non-mic failure carries no message of its own. */
  fallbackErrorMessage: string;
}

/**
 * The start scaffolding both session controllers share (previously duplicated
 * verbatim in each): the already-live no-op guard, generation bump,
 * `'requesting-mic'` state, mic acquisition with {@link wrapMicError}
 * classification, discarding a mic stream a concurrent `stop()` made stale,
 * and the error catch that distinguishes mic failures (typed kind) from
 * everything else (never `reconnectable` — every failure visible here
 * happened before `'connected'` was ever reached; post-connect drops go
 * through each controller's own `handlePostConnectFailure`).
 */
export async function runSessionStart(hooks: SessionStartHooks): Promise<void> {
  if (
    hooks.status === 'requesting-mic' ||
    hooks.status === 'connecting' ||
    hooks.status === 'connected'
  ) {
    return;
  }

  const myGeneration = hooks.bumpGeneration();
  hooks.setState('requesting-mic');

  try {
    const localStream = await hooks.getUserMedia({ audio: MIC_AUDIO_CONSTRAINTS }).catch((rawError: unknown) => {
      throw wrapMicError(rawError);
    });
    if (!hooks.isCurrent(myGeneration)) {
      // stop() ran while the mic prompt was pending; discard the now-unwanted stream.
      for (const track of localStream.getTracks()) track.stop();
      return;
    }
    hooks.storeStream(localStream);

    hooks.setState('connecting');
    await hooks.connect(localStream, myGeneration);
    if (!hooks.isCurrent(myGeneration)) return;

    hooks.setState('connected');
  } catch (error) {
    if (!hooks.isCurrent(myGeneration)) return;
    hooks.teardown();
    if (error instanceof MicAccessError) {
      hooks.setState('error', error.message, error.kind);
      return;
    }
    hooks.setState('error', error instanceof Error ? error.message : hooks.fallbackErrorMessage);
  }
}
