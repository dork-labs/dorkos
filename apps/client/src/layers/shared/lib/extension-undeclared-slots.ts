/**
 * The places each app tried to show itself in without declaring them in its
 * manifest's `contributions` (DOR-4282). DorkOS refuses those registrations;
 * the app's Settings row reads this to say which places it tried, so the
 * person can ask its maker for an update. Kept in the browser only: it is a
 * fact about this page load, and a reload starts it again.
 *
 * @module shared/lib/extension-undeclared-slots
 */
import { useSyncExternalStore } from 'react';
import { isContributionKey } from '@dorkos/extension-api';

const EMPTY: readonly string[] = [];

let refused: Readonly<Record<string, readonly string[]>> = {};
const listeners = new Set<() => void>();

function publish(next: Readonly<Record<string, readonly string[]>>): void {
  refused = next;
  listeners.forEach((listener) => listener());
}

/**
 * Note one refused place for an app. Noting the same place twice changes
 * nothing, and a key that is not one of DorkOS's places is dropped: the row
 * names places only in DorkOS's own words (`CONTRIBUTION_WORDS`), never a
 * string the app supplied.
 *
 * @param id - The app's id.
 * @param key - The `contributions` key it did not declare.
 */
export function noteUndeclaredSlot(id: string, key: string): void {
  if (!isContributionKey(key)) return;
  const current = refused[id] ?? EMPTY;
  if (current.includes(key)) return;
  publish({ ...refused, [id]: [...current, key] });
}

/**
 * Forget what an app tried, before it loads again or when it is removed.
 *
 * @param id - The app's id.
 */
export function clearUndeclaredSlots(id: string): void {
  if (!(id in refused)) return;
  const next = { ...refused };
  delete next[id];
  publish(next);
}

/**
 * The places an app tried without declaring them, in the order it tried.
 *
 * @param id - The app's id.
 */
export function getUndeclaredSlots(id: string): readonly string[] {
  return refused[id] ?? EMPTY;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The places an app tried without declaring them, kept current.
 *
 * @param id - The app's id.
 */
export function useUndeclaredSlots(id: string): readonly string[] {
  const read = () => getUndeclaredSlots(id);
  return useSyncExternalStore(subscribe, read, read);
}
