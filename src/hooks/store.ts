import { useSyncExternalStore } from "react";

/**
 * Minimal observable value used by the shell's framework-independent state
 * (sessions, dialogs, notices…). React reads it with `useStore`, which only
 * re-renders the components that subscribe to that particular store.
 */
export interface ReadableStore<T> {
  get(): T;
  subscribe(listener: () => void): () => void;
}

export interface Store<T> extends ReadableStore<T> {
  set(next: T): void;
  update(fn: (current: T) => T): void;
}

export function createStore<T>(initial: T, equals: (a: T, b: T) => boolean = Object.is): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  const set = (next: T) => {
    if (equals(state, next)) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    get: () => state,
    set,
    update: (fn) => set(fn(state)),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function useStore<T>(store: ReadableStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** Simple multi-listener event emitter. */
export class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  emit(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }

  subscribe = (listener: (value: T) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}
