/**
 * Stable per-tab client id for the web cockpit.
 *
 * The client id travels as `X-Client-Id` and is two things at once: the identity
 * a queued chip is attributed to (P2.6 — "not yours" marks chips from other
 * windows), and the session write-lock owner (DOR-782). Both want the SAME
 * answer across a refresh of one tab: the returning tab should see its own chips
 * as its own, and be recognized as the still-live owner of any turn it left
 * running (a turn's lock is keyed by client id and its same-client successors
 * serialize through one queue — DOR-1088 — rather than being refused).
 *
 * `sessionStorage` is the exact fit: it survives a refresh of the same tab and
 * is NOT shared with a genuinely new tab (a new tab starts with empty
 * sessionStorage and mints a fresh id). A duplicated tab that copies
 * sessionStorage is the only way two tabs share an id, and that degrades to
 * same-client turn serialization — never a concurrent writer — so it stays
 * lock-safe. `localStorage` would be wrong: shared across every tab, it would
 * collapse all windows into one identity. See `contributing/` and DOR-1162.
 *
 * @module shared/lib/transport/client-id
 */

/** sessionStorage key under which the web cockpit's stable client id is kept. */
const CLIENT_ID_STORAGE_KEY = 'dorkos.web-client-id';

/** Prefix marking a client id as minted by the web cockpit surface. */
const WEB_CLIENT_ID_PREFIX = 'web-';

/** Mint a fresh web client id. */
function mintClientId(): string {
  return `${WEB_CLIENT_ID_PREFIX}${crypto.randomUUID()}`;
}

/**
 * Resolve the web cockpit's client id, stable across a refresh of the same tab.
 *
 * Reuses the id persisted in `sessionStorage` when present, otherwise mints one
 * and persists it. Falls back to a freshly minted (unpersisted) id whenever
 * `sessionStorage` is unavailable or throws — private-mode quotas, SSR, or an
 * embedded surface without a DOM. The returned value always carries the
 * `web-` prefix.
 */
export function resolveStableClientId(): string {
  let store: Storage | undefined;
  try {
    store = globalThis.sessionStorage;
  } catch {
    // Accessing sessionStorage can itself throw (sandboxed iframes, some
    // privacy modes). Treat any failure as "no storage" and mint.
    store = undefined;
  }
  if (!store) return mintClientId();

  try {
    const existing = store.getItem(CLIENT_ID_STORAGE_KEY);
    if (existing && existing.startsWith(WEB_CLIENT_ID_PREFIX)) return existing;
    const minted = mintClientId();
    store.setItem(CLIENT_ID_STORAGE_KEY, minted);
    return minted;
  } catch {
    // getItem/setItem can throw under storage quotas or blocked storage.
    return mintClientId();
  }
}

/** @internal Exported for tests — the sessionStorage key the id lives under. */
export const CLIENT_ID_STORAGE_KEY_FOR_TEST = CLIENT_ID_STORAGE_KEY;
