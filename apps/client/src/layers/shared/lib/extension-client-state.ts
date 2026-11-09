import { useSyncExternalStore } from 'react';

/** The browser's own answer, independent of the server half's status. */
export type ExtensionClientState = 'starting' | 'ready' | 'error';

let states: Readonly<Record<string, ExtensionClientState>> = {};
const listeners = new Set<() => void>();

/** Read the current browser load states. */
export function getExtensionClientStates(): Readonly<Record<string, ExtensionClientState>> {
  return states;
}

/** Record one browser load attempt's state; undefined forgets a removed app. */
export function setExtensionClientState(id: string, state: ExtensionClientState | undefined): void {
  if (states[id] === state) return;
  const next = { ...states };
  if (state === undefined) delete next[id];
  else next[id] = state;
  states = next;
  listeners.forEach((listener) => listener());
}

/** Subscribe to browser load state changes. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Keep app lists in sync as individual bundles start or stop working. */
export function useExtensionClientStates(): Readonly<Record<string, ExtensionClientState>> {
  return useSyncExternalStore(subscribe, getExtensionClientStates, getExtensionClientStates);
}
