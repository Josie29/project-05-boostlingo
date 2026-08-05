/**
 * The session-lifecycle vocabulary shared by both transports. A leaf module
 * (no imports from `realtime/`, `cascade/`, or `session/InterpreterSession.ts`)
 * so it can be imported from anywhere — including each transport's own
 * `types.ts` — without creating a cycle.
 *
 * Previously `SessionStatus`/`SessionErrorKind`/`SessionState`/
 * `INITIAL_SESSION_STATE` were defined three times: once here, once under
 * `RealtimeSessionStatus`/etc. in `realtime/types.ts`, and once under
 * `CascadeSessionStatus`/etc. in `cascade/types.ts` — structurally identical
 * on all three copies since `RealtimeSessionController` and
 * `CascadeSessionController` independently converged on the exact same
 * vocabulary, which is what makes a single mode-agnostic status display
 * possible in the first place. Both transport-specific `types.ts` files now
 * import and re-export these under their own names instead of redefining
 * them.
 */

/** Lifecycle states shared by both transports. */
export type SessionStatus = 'idle' | 'requesting-mic' | 'connecting' | 'connected' | 'error';

/**
 * Narrows *why* an `'error'` status happened, for the two cases the shared UI
 * (issue #12) needs to render distinctly from a generic failure message:
 * `getUserMedia` being denied outright vs. no microphone existing at all.
 * `null` for every other failure (a token-mint 503/502/400, a dead socket, a
 * per-stage cascade failure that killed the session, ...), which the plain
 * `errorMessage` already explains well enough on its own.
 */
export type SessionErrorKind = 'mic-denied' | 'mic-not-found' | null;

/** Small state snapshot the UI renders from, regardless of which transport produced it. */
export interface SessionState {
  status: SessionStatus;
  /** Human-readable failure reason, set only when `status` is `'error'`. */
  errorMessage: string | null;
  /** See {@link SessionErrorKind}. `null` unless `status` is `'error'`. */
  errorKind: SessionErrorKind;
  /**
   * True when `status` is `'error'` *because a previously-`'connected'` session
   * died mid-call* (a cascade stage error with `recoverable: false`, or a
   * WebRTC connection drop) — issue #12's Reconnect affordance, which tears
   * the dead transport down and starts a fresh one with the same language
   * pair while preserving transcript history, applies only to this case.
   * `false` for a failure that never reached `'connected'` in the first place
   * (a denied mic, a failed token mint), where a plain `start()` retry is
   * already the right recovery and there is nothing "re-" about it.
   */
  reconnectable: boolean;
}

/** The state every session/controller starts in and returns to after `stop()`. */
export const INITIAL_SESSION_STATE: SessionState = {
  status: 'idle',
  errorMessage: null,
  errorKind: null,
  reconnectable: false,
};
