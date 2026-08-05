import { describe, expect, it } from 'vitest';
import { ListenerSet } from '../session/listenerSet';

describe('ListenerSet', () => {
  // Catches the core fan-out bug: every registered listener must be notified
  // of a value, not just the first/last one registered — the pattern this
  // class centralizes for every controller/session adapter's subscribe/emit.
  it('notifies every registered listener when emit() is called', () => {
    const set = new ListenerSet<number>();
    const received: number[][] = [[], []];
    set.add((value) => received[0].push(value));
    set.add((value) => received[1].push(value));

    set.emit(1);
    set.emit(2);

    expect(received).toEqual([[1, 2], [1, 2]]);
  });

  // Catches an unsubscribe-doesn't-work bug: a listener that's already
  // unsubscribed must not still receive later emissions — the exact
  // regression a leaked subscription (e.g. a stale component instance still
  // reacting to state changes) would look like.
  it('stops notifying a listener once its unsubscribe function is called', () => {
    const set = new ListenerSet<string>();
    const received: string[] = [];
    const unsubscribe = set.add((value) => received.push(value));

    set.emit('first');
    unsubscribe();
    set.emit('second');

    expect(received).toEqual(['first']);
  });

  // Catches a bug where unsubscribing one listener accidentally drops another
  // — each add() must return an unsubscribe function scoped to that specific
  // listener, not a blunt "clear everything."
  it('unsubscribing one listener leaves other listeners registered', () => {
    const set = new ListenerSet<string>();
    const received: string[] = [];
    const unsubscribeFirst = set.add(() => received.push('first'));
    set.add(() => received.push('second'));

    unsubscribeFirst();
    set.emit('tick');

    expect(received).toEqual(['second']);
  });

  // Catches a teardown bug: clear() must drop every registered listener at
  // once, mirroring how a controller's own full teardown needs to guarantee
  // no stale listener keeps firing after the owning session is gone.
  it('clear() drops every registered listener', () => {
    const set = new ListenerSet<string>();
    const received: string[] = [];
    set.add((value) => received.push(value));
    set.add((value) => received.push(value));

    set.clear();
    set.emit('tick');

    expect(received).toEqual([]);
  });
});
