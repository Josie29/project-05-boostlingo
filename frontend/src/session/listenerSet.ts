/**
 * A small `Set<listener>` wrapper for the subscribe/emit/unsubscribe pattern
 * repeated, hand-rolled, across every controller and session adapter in this
 * codebase (`RealtimeInterpreterSession`, `CascadeInterpreterSession`, and —
 * where it drops in cleanly — the two transport controllers). Centralizing it
 * here means the add/emit/cleanup logic is written and tested once instead of
 * copy-pasted at each call site.
 */
export class ListenerSet<T> {
  private readonly listeners = new Set<(value: T) => void>();

  /** Registers `listener`. Returns an unsubscribe function that removes it. */
  add(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Notifies every currently-registered listener with `value`, in registration order. */
  emit(value: T): void {
    for (const listener of this.listeners) listener(value);
  }

  /** Drops every registered listener, e.g. as part of a full teardown. */
  clear(): void {
    this.listeners.clear();
  }
}
