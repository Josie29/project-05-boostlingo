/**
 * Classifies a `getUserMedia` rejection (issue #12) so both transports can
 * render a distinct, actionable state — "you blocked mic access" vs. "no mic
 * exists" vs. a generic failure — instead of the one undifferentiated error
 * message every other `start()` failure gets.
 *
 * Kept here rather than duplicated in `RealtimeSessionController` and
 * `CascadeSessionController` since both call `getUserMedia` with the exact
 * same constraints (`MIC_AUDIO_CONSTRAINTS`) and need to classify its
 * rejection identically — this is the mic half of what that file already
 * shares between the two transports.
 */

/** The two mic-specific failures either transport's `start()` can classify. */
export type MicErrorKind = 'mic-denied' | 'mic-not-found';

/**
 * Thrown in place of a raw `getUserMedia` rejection once it's been
 * classified, so a controller's outer `catch` in `start()` can distinguish
 * "the mic step itself failed for a recognized reason" from any other error
 * later in the same try block (fetching a token, negotiating a peer
 * connection, ...) without guessing at an error's `name` out of context —
 * see {@link wrapMicError}.
 */
export class MicAccessError extends Error {
  readonly kind: MicErrorKind;

  constructor(kind: MicErrorKind, message: string) {
    super(message);
    this.name = 'MicAccessError';
    this.kind = kind;
  }
}

/**
 * `DOMException.name` values browsers use for `getUserMedia` rejecting
 * because the user (or an OS-level policy) denied permission. Firefox has
 * historically used `PermissionDeniedError` where Chromium uses
 * `NotAllowedError`; `SecurityError` covers a permissions-policy/insecure-
 * context denial that never even reached a user prompt.
 */
const PERMISSION_DENIED_NAMES = new Set(['NotAllowedError', 'PermissionDeniedError', 'SecurityError']);

/** `DOMException.name` values for "no device matched the request" — no mic present, or none satisfying the requested constraints. */
const NO_DEVICE_NAMES = new Set(['NotFoundError', 'DevicesNotFoundError', 'OverconstrainedError']);

/** Classifies a raw `getUserMedia` rejection by its `DOMException` name, or `null` if it isn't one of the two recognized mic failures. */
function classifyMicError(error: unknown): MicErrorKind | null {
  const name = error !== null && typeof error === 'object' && 'name' in error ? (error as { name?: unknown }).name : undefined;
  if (typeof name !== 'string') return null;
  if (PERMISSION_DENIED_NAMES.has(name)) return 'mic-denied';
  if (NO_DEVICE_NAMES.has(name)) return 'mic-not-found';
  return null;
}

/**
 * Wraps a `getUserMedia` rejection into a {@link MicAccessError} when it's a
 * recognized permission/hardware failure, carrying a short human-readable
 * message; returns the original error unchanged otherwise (a generic
 * failure still surfaces via the existing `error.message`/generic-fallback
 * path). Call this at the `getUserMedia` call site specifically — not in a
 * broader `catch` — so a same-named error from something else in `start()`
 * is never misclassified as a mic problem it isn't.
 */
export function wrapMicError(error: unknown): unknown {
  const kind = classifyMicError(error);
  if (!kind) return error;
  const message =
    kind === 'mic-denied' ? 'Microphone access was blocked.' : 'No microphone was found.';
  return new MicAccessError(kind, message);
}
