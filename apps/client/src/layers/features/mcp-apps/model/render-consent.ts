/**
 * First-use render consent for MCP Apps, remembered per server (spec
 * `mcp-apps-host` §2.3). Interactive HTML from a third-party MCP server runs
 * (sandboxed) scripts, so the first App from a given server asks the user before
 * it renders; the choice is remembered in `localStorage` and keyed by server
 * name so a trusted server never asks twice.
 *
 * @module features/mcp-apps/model/render-consent
 */
import { useCallback, useSyncExternalStore } from 'react';

const STORAGE_PREFIX = 'dorkos:mcp-app-consent:';

/** Storage key for a server's consent flag. */
function keyFor(serverName: string): string {
  return `${STORAGE_PREFIX}${serverName}`;
}

/** Whether the user has already consented to render Apps from `serverName`. */
export function hasRenderConsent(serverName: string): boolean {
  try {
    return localStorage.getItem(keyFor(serverName)) === 'granted';
  } catch {
    // Private-mode / disabled storage: treat as no stored consent (asks again).
    return false;
  }
}

/** Persist consent for `serverName` and notify subscribers. */
export function grantRenderConsent(serverName: string): void {
  try {
    localStorage.setItem(keyFor(serverName), 'granted');
  } catch {
    // Non-fatal: consent simply won't persist across reloads.
  }
  notify();
}

// --- React binding ---------------------------------------------------------

const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Cross-tab: a grant in another tab fires a `storage` event here.
  const onStorage = (e: StorageEvent): void => {
    if (e.key?.startsWith(STORAGE_PREFIX)) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/**
 * Reactive per-server render consent. Re-renders when consent is granted (this
 * tab or another).
 *
 * @param serverName - MCP server whose consent state to track.
 * @returns `{ consented, grant }` — the current flag and a grant callback.
 */
export function useRenderConsent(serverName: string): {
  consented: boolean;
  grant: () => void;
} {
  const consented = useSyncExternalStore(
    subscribe,
    () => hasRenderConsent(serverName),
    () => false
  );
  const grant = useCallback(() => grantRenderConsent(serverName), [serverName]);
  return { consented, grant };
}
