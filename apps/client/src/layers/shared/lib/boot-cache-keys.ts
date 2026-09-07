/**
 * Where the sidebar's local memory lives, and what is allowed into it.
 *
 * **A leaf on purpose (DOR-1809).** These are the halves of `query-persister`
 * that a surface can want without wanting a cache: sign-out wipes every entry,
 * the Dev Playground lists them, and the allow-list decides which query keys
 * belong to the first paint. None of that needs the persister, and — more to
 * the point — none of it needs a Transport. `createBootCache` does, because it
 * refuses to persist for anything but `HttpTransport`, and that one
 * `instanceof` is a ~35-module dependency. Keeping these names here is what
 * lets `shared/lib`'s barrel carry them without carrying the client-server
 * seam behind them; see the barrel's own note.
 *
 * The prose that explains WHY a boot cache exists at all is on
 * `shared/lib/query-persister`, which is the thing that builds one.
 *
 * @module shared/lib/boot-cache-keys
 */

/**
 * The prefix every cockpit's cache entry shares.
 *
 * Public because the wipe is by prefix: "forget every install this browser has
 * seen" is what a sign-out and a Dev Playground button both mean.
 */
export const BOOT_CACHE_KEY_PREFIX = 'dorkos:rq:';

/**
 * The key that turns local memory OFF for a browser session.
 *
 * **A determinism seam for the browser suite, and nothing else.** The cockpit's
 * e2e specs were written against a cold first paint: a fresh context per test,
 * every load starting from nothing. Local memory changes that *within* a test —
 * the second `page.goto` in a spec restores what the first one left — so specs
 * that assert on paint order, scroll anchoring, or a live lane's first frame
 * start racing a warm boot they were never written for, and a slow CI machine
 * widens every one of those races.
 *
 * Rather than teach forty specs about a cache none of them are testing, the
 * suite turns it off by default (`fixtures/index.ts` sets this on every context)
 * and `dashboard-sidebar/boot-stability.spec.ts` — the one spec whose whole
 * subject is warm boot — opts back in. Every other spec keeps the cold world it
 * was written against, and the feature is still exercised deliberately where it
 * is owned.
 *
 * Read only at construction, so a real user's session can never reach this: it
 * requires someone to have written the key into their own `localStorage` first.
 */
export const BOOT_CACHE_DISABLED_KEY = 'dorkos:boot-cache-disabled';

/**
 * How long a remembered answer may still be painted.
 *
 * A day, because that is roughly the span over which a person's fleet and
 * channels stay recognisable. Past it the shape has probably moved enough that a
 * skeleton is the more honest first frame, and the whole blob is dropped rather
 * than half-trusted.
 */
export const BOOT_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The cache key for one cockpit.
 *
 * @param apiBaseUrl - What `resolveApiBaseUrl()` handed the transport — a
 *   relative `/api` in the browser, an absolute `http://localhost:<port>/api` in
 *   the desktop shell. Both resolve to the origin that answers.
 */
export function bootCacheStorageKey(apiBaseUrl: string): string {
  return `${BOOT_CACHE_KEY_PREFIX}${new URL(apiBaseUrl, window.location.origin).origin}`;
}

/**
 * Whether one cache entry is part of the sidebar's first paint.
 *
 * **Spelled literally rather than imported.** This file is in `shared/`, which
 * may not import the entity modules the keys are declared in (FSD). The drift
 * that invites is guarded rather than tolerated:
 * `features/dashboard-sidebar/model/boot/__tests__/warm-boot.test.tsx` fills a
 * real cache through the real hooks, persists it through this predicate and
 * boots a second client from the result with the network silenced — so a key
 * spelled here that the hooks do not use reddens a test instead of quietly
 * emptying the cache.
 *
 * Everything is matched on an exact shape, never a bare prefix, because several
 * of these keys are the ROOT of a family holding a different payload —
 * `['rooms','list','with-archived',…]` is the command palette's separate
 * question, `['team','rooms',<id>]` is one member's rooms — and none of those
 * belong in the first paint.
 *
 * @param queryKey - The key the cache holds the entry under.
 */
export function isBootQueryKey(queryKey: readonly unknown[]): boolean {
  const [head, second] = queryKey;
  switch (head) {
    // `configKeys.current()` — pins, groups, collapse and mute state.
    case 'config':
      return queryKey.length === 2 && second === 'current';
    // `roomKeys.list(kind)` (length 3) and `roomKeys.threads()` (length 2).
    // `listWithArchived` is length 4 and falls through.
    case 'rooms':
      if (second === 'list') return queryKey.length === 3;
      return queryKey.length === 2 && second === 'threads';
    // `['mesh','agent-paths']` — how many agent rows there will be.
    case 'mesh':
      return queryKey.length === 2 && second === 'agent-paths';
    // `agentKeys.resolved(paths)` — every agent's real name and face. Variadic
    // in the paths, so this one is a prefix by nature.
    case 'agents':
      return second === 'resolved';
    // `sessionKeys.recent(limit)` — Today's rows and the Agents section's order.
    case 'recent-sessions':
      return queryKey.length === 2 && typeof second === 'number';
    // `TEAM_ROSTER_KEY` — the header's team name. Exactly `['team']`; the
    // per-member rooms underneath it are a different shape and a different
    // question.
    case 'team':
      return queryKey.length === 1;
    default:
      return false;
  }
}

/**
 * Forget every cockpit's remembered panel.
 *
 * Used by sign-out — one person's rooms and agents must not be the first thing
 * the next person sees — and by the Dev Playground's "Clear sidebar cache".
 *
 * @param storage - Where the entries live. Defaults to this browser's
 *   `localStorage`; injectable so a test can hand it a fake.
 */
export function clearBootCache(storage: Storage = window.localStorage): void {
  for (const key of bootCacheKeys(storage)) storage.removeItem(key);
}

/**
 * Drop every cockpit's entry except the one this session belongs to.
 *
 * A person who moves an install to another port, or opens a second machine
 * through a tunnel, would otherwise leave the old blob behind forever — it is
 * keyed by an origin nothing asks for again, so nothing would ever expire it.
 *
 * Exported to `query-persister` and to nobody else — it was a private helper
 * beside its one caller until the split moved the two apart. It is deliberately
 * not on the barrel: "keep exactly this one" is a claim only the module that
 * writes the entry is in a position to make.
 *
 * @param keep - The key this session writes.
 * @param storage - Where the entries live.
 */
export function pruneForeignBootCaches(keep: string, storage: Storage): void {
  for (const key of bootCacheKeys(storage)) {
    if (key !== keep) storage.removeItem(key);
  }
}

/** Every `dorkos:rq:*` key currently in a storage, as a snapshot safe to delete from. */
function bootCacheKeys(storage: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null && key.startsWith(BOOT_CACHE_KEY_PREFIX)) keys.push(key);
  }
  return keys;
}
