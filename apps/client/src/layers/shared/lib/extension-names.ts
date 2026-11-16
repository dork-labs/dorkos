import { useSyncExternalStore } from 'react';

/**
 * Each installed app's name, from DorkOS's own records (DOR-3293).
 *
 * Filled by the extension loader every time it lists the installed apps, so a
 * surface that names an app — "Opened by Desk" on a canvas tab — reads DorkOS's
 * answer, never anything the app or its page says about itself.
 *
 * @module shared/lib/extension-names
 */

let names: Readonly<Record<string, string>> = {};
const listeners = new Set<() => void>();

/** Read the current app names, by id. */
export function getExtensionNames(): Readonly<Record<string, string>> {
  return names;
}

/**
 * Replace the app names with this listing.
 *
 * @param next - Each installed app's id and its name from DorkOS's records.
 */
export function setExtensionNames(next: Readonly<Record<string, string>>): void {
  names = next;
  listeners.forEach((listener) => listener());
}

/** Subscribe to app name changes. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Every installed app's name by id, kept in step with the loader's listing. */
export function useExtensionNames(): Readonly<Record<string, string>> {
  return useSyncExternalStore(subscribe, getExtensionNames, getExtensionNames);
}
