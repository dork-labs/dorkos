/**
 * Whether the app's mini apps failed to load — a module signal the extension
 * loader sets and any surface that lists mini apps reads.
 *
 * **A failed load is never "no mini apps".** When the extension list is refused
 * or unreachable, the loader has nothing to register, and a surface that only
 * counted what registered would draw the same empty state as a computer with
 * none installed. This flag is the difference: set, a surface says the load
 * failed and offers to try again (`requestExtensionRemount`).
 *
 * In the shared layer for the reason `extension-remount` is: the extensions
 * feature writes it and the sidebar feature reads it, and neither may import
 * the other.
 *
 * @module shared/lib/extension-load-status
 */
import { useSyncExternalStore } from 'react';

let loadFailed = false;
const listeners = new Set<() => void>();

/** Whether the last full load of the extension list failed. */
export function getExtensionLoadFailed(): boolean {
  return loadFailed;
}

/**
 * Record whether the last full load of the extension list failed.
 *
 * @param failed - True when the list could not be read; false once it was.
 */
export function setExtensionLoadFailed(failed: boolean): void {
  if (loadFailed === failed) return;
  loadFailed = failed;
  listeners.forEach((listener) => listener());
}

/**
 * Subscribe to changes of {@link getExtensionLoadFailed}.
 *
 * @param listener - Called after each change.
 * @returns An unsubscribe function.
 */
export function subscribeExtensionLoadFailed(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the app's mini apps failed to load, kept live. */
export function useExtensionLoadFailed(): boolean {
  return useSyncExternalStore(
    subscribeExtensionLoadFailed,
    getExtensionLoadFailed,
    getExtensionLoadFailed
  );
}
