/**
 * The sidebar's local memory: the handful of answers a reload may paint from
 * before the server has said anything (spec `sidebar-simplification` D6).
 *
 * **Why it exists.** The panel's shape — which channels, which agents, which
 * conversations from today — is the same on this load as it was on the last one,
 * give or take a row. Asking the server for all of it before drawing anything is
 * what made a reload a second of bones. Keeping the last answer in the browser's
 * own storage lets the first frame be the finished panel, with the network doing
 * its round trip behind it and correcting whatever moved.
 *
 * **Why it is an ALLOW-LIST and not a size cap.** Only the queries the boot gate
 * waits on earn a place here, spelled out one by one. Two reasons. A transcript
 * or an event stream persisted this way would be replayed as fact on the next
 * load and then corrected in front of the operator, which is worse than a blank
 * — and it would put someone's conversations in `localStorage`, which is not
 * where they live. And what needs a person's attention right now — parked
 * approvals, questions an agent asked — is deliberately NOT here: a stale "you
 * have three things waiting" that resolves to zero a beat later is a lie told
 * confidently. Those three queries stay cold, and the boot gate's 1500 ms
 * ceiling (`boot-gate.ts`) means a cold one cannot hold the reveal shut.
 *
 * **Why it is keyed by origin.** One browser can hold two cockpits — a dev
 * server on :6241 and the installed one on :4242, or two machines behind two
 * tunnels. They are different installs with different rooms and different
 * agents, and painting one from the other's memory would be a wrong panel, not a
 * stale one.
 *
 * @module shared/lib/query-persister
 */
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import {
  defaultShouldDehydrateQuery,
  dehydrate,
  hydrate,
  type QueryClient,
} from '@tanstack/react-query';
import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';

import type { Transport } from '@dorkos/shared/transport';

import { HttpTransport } from './transport';

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
 * How long the writer waits before saving again.
 *
 * The save runs on every cache event, and boot alone produces dozens. One
 * serialize per second is invisible to the operator and keeps a
 * `JSON.stringify` of the whole allow-list off the frames that matter.
 */
const SAVE_THROTTLE_MS = 1_000;

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
 * @param keep - The key this session writes.
 * @param storage - Where the entries live.
 */
function pruneForeignBootCaches(keep: string, storage: Storage): void {
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

/**
 * The dehydrate rule: in the allow-list, and holding an answer worth keeping.
 *
 * One function so the throttled save and the `pagehide` flush cannot come to
 * disagree about what may be written.
 */
function shouldPersist(query: { queryKey: readonly unknown[] }): boolean {
  return (
    isBootQueryKey(query.queryKey) &&
    defaultShouldDehydrateQuery(query as Parameters<typeof defaultShouldDehydrateQuery>[0])
  );
}

/**
 * Whether a blob read back out of storage is shaped like something to hydrate.
 *
 * **Valid JSON is not a valid cache**, and the difference is the whole reason
 * this exists. `localStorage` is a shared, writable namespace: a browser
 * extension, an old build of this app, a half-finished write cut off by a
 * crashing tab, or a person poking at devtools can all leave a well-formed JSON
 * document here that `hydrate` then walks into. `hydrate` reads
 * `clientState.queries` and then reads fields off each entry, so a `queries`
 * that is a string, or an array with a `null` in it, throws inside React's
 * render path rather than at a boundary we control.
 *
 * So the shape is checked BEFORE hydration rather than repaired after it. What
 * fails here is thrown away and the next load is simply cold, which is the
 * behaviour a person can live with; a blank cockpit is not.
 *
 * @param value - Whatever `JSON.parse` produced for the stored blob.
 */
function isRestorableClient(value: unknown): value is PersistedClient {
  if (typeof value !== 'object' || value === null) return false;
  const client = value as Partial<PersistedClient>;
  if (typeof client.timestamp !== 'number') return false;
  const state = client.clientState;
  if (typeof state !== 'object' || state === null) return false;
  if (!Array.isArray(state.queries)) return false;
  return state.queries.every(
    (query) =>
      typeof query === 'object' &&
      query !== null &&
      Array.isArray((query as { queryKey?: unknown }).queryKey)
  );
}

/**
 * What the app root needs to boot from local memory and to keep it current.
 *
 * **There is no `restore` here, and that was measured rather than assumed.**
 * `PersistQueryClientProvider` restores through a promise, so the obvious worry
 * is that its data lands a microtask after the first paint — too late for
 * `useBootState`'s `startedWarm`, which is latched at mount. An earlier draft of
 * this file therefore hydrated synchronously before `createRoot().render()`.
 *
 * It was not buying anything. Against a PRODUCTION build (one bundle, not dev's
 * few hundred module requests), with and without that call, a warm reload showed
 * no skeleton and exactly one distinct picture of the row list, twice each —
 * first row at 125-142 ms either way. The provider holds queries paused while
 * `isRestoring`, and its restore resolves well before the router has mounted the
 * sidebar. The measurement is in the PR body; the probe is
 * `scratchpad/3.2/probe-sync-restore.mjs`.
 *
 * So the synchronous path is gone, and with it the double-read plumbing it
 * needed. Its removal also closed a real hazard: hydrating at module scope put
 * `hydrate` outside every error boundary, where one malformed blob in
 * `localStorage` was a blank cockpit rather than a cold boot.
 */
export interface BootCache {
  /**
   * Write the cache to storage now, without waiting for the throttle.
   *
   * **What makes the memory safe to paint from.** The ordinary save runs on a
   * one-second throttle, which is right for a boot that fires dozens of cache
   * events — and wrong for the last second before a reload. Dismiss a card,
   * create a section, mute a room and reload straight away, and the blob still
   * held the state from BEFORE the change: the panel painted the card you just
   * dismissed, then took it away again when the server answered. Two browser
   * specs caught exactly that (`sidebar-bottom-slot`, `sidebar-groups`).
   *
   * Wired to `pagehide`, which is the browser saying it is leaving — the one
   * moment where a synchronous write is both cheap and necessary.
   *
   * @param queryClient - The client whose current answers to write.
   */
  flush(queryClient: QueryClient): void;
  /** What `PersistQueryClientProvider` needs to keep writing the blob. */
  persistOptions: {
    persister: Persister;
    maxAge: number;
    buster: string;
    dehydrateOptions: {
      shouldDehydrateQuery: (query: { queryKey: readonly unknown[] }) => boolean;
    };
  };
}

/**
 * Build the sidebar's local memory, or decide this surface has none.
 *
 * @param options.transport - How this surface talks to its server. Only
 *   {@link HttpTransport} persists: the Obsidian embed runs the server in the
 *   same process, so its reads are already local and writing them into the
 *   vault's browser storage would buy nothing and leak a person's rooms into a
 *   store the plugin never clears.
 * @param options.apiBaseUrl - The base URL the transport was built with; keys
 *   the entry to one install.
 * @param options.buster - The build's version. A new build may have changed what
 *   a payload looks like, so it starts from an empty memory rather than
 *   hydrating yesterday's shape into today's components.
 * @param options.storage - Where to keep it. Defaults to `localStorage`.
 * @returns The cache, or `null` when this surface must not persist.
 */
export function createBootCache(options: {
  transport: Transport;
  apiBaseUrl: string;
  buster: string;
  storage?: Storage;
}): BootCache | null {
  const { transport, apiBaseUrl, buster } = options;
  if (!(transport instanceof HttpTransport)) return null;

  const storage = options.storage ?? window.localStorage;
  // Switched off for this session — see {@link BOOT_CACHE_DISABLED_KEY}. Checked
  // before anything is read, written or pruned, so a disabled session leaves the
  // storage exactly as it found it.
  if (storage.getItem(BOOT_CACHE_DISABLED_KEY) !== null) return null;
  const key = bootCacheStorageKey(apiBaseUrl);
  pruneForeignBootCaches(key, storage);

  const persister = createSyncStoragePersister({
    storage,
    key,
    throttleTime: SAVE_THROTTLE_MS,
  });

  /**
   * Write, unless there is nothing to remember.
   *
   * **An empty write is how a sign-out undid itself.** Signing out clears the
   * storage AND drops the boot queries from the cache — and dropping them is a
   * cache event, so the throttled save fires up to a second later and recreates
   * the key holding `queries: []`. The person is left with an empty artefact of
   * a session they ended. Nothing to remember means nothing on disk.
   */
  const write = (client: PersistedClient): void => {
    if (client.clientState.queries.length === 0) {
      persister.removeClient();
      return;
    }
    persister.persistClient(client);
  };

  return {
    flush(queryClient) {
      const clientState = dehydrate(queryClient, { shouldDehydrateQuery: shouldPersist });
      if (clientState.queries.length === 0) {
        storage.removeItem(key);
        return;
      }
      try {
        storage.setItem(key, JSON.stringify({ buster, timestamp: Date.now(), clientState }));
      } catch {
        // A full quota on the way out of the page is not worth a thrown error
        // nobody can see. The next load reads whatever the throttled save left.
      }
    },
    persistOptions: {
      maxAge: BOOT_CACHE_MAX_AGE_MS,
      buster,
      dehydrateOptions: { shouldDehydrateQuery: shouldPersist },
      persister: {
        persistClient: (client) => write(client),
        removeClient: () => persister.removeClient(),
        /**
         * Read the blob, and refuse anything `hydrate` would choke on.
         *
         * The library's own restore wraps `hydrate` in a try/catch and drops the
         * blob when it throws — but it rethrows too, and either way the check
         * belongs before the data reaches React rather than after. See
         * {@link isRestorableClient} for what "malformed" covers and why valid
         * JSON is not enough.
         */
        restoreClient: async () => {
          try {
            const restored = await persister.restoreClient();
            if (restored === undefined) return undefined;
            if (!isRestorableClient(restored)) {
              persister.removeClient();
              return undefined;
            }
            return restored;
          } catch {
            persister.removeClient();
            return undefined;
          }
        },
      },
    },
  };
}
