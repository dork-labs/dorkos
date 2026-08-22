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
import { defaultShouldDehydrateQuery, hydrate, type QueryClient } from '@tanstack/react-query';
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

/** Read the blob without waiting for a microtask. Any damage to it reads as "nothing remembered". */
function readPersistedClient(storage: Storage, key: string): PersistedClient | undefined {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return undefined;
    return JSON.parse(raw) as PersistedClient;
  } catch {
    return undefined;
  }
}

/** Whether a remembered blob is still one this build may paint. */
function isUsable(persisted: PersistedClient, buster: string): boolean {
  if (typeof persisted.timestamp !== 'number') return false;
  if (persisted.buster !== buster) return false;
  return Date.now() - persisted.timestamp <= BOOT_CACHE_MAX_AGE_MS;
}

/** What the app root needs to boot from local memory and to keep it current. */
export interface BootCache {
  /**
   * Put the remembered answers into the query cache, right now.
   *
   * **Must run before the first render**, and that is the whole point of it.
   * `PersistQueryClientProvider` restores through a promise, so its data lands a
   * microtask after the first paint — one frame too late for
   * `useBootState`'s `startedWarm`, which is latched at mount and decides
   * whether the panel animates into place or is simply there.
   *
   * @param queryClient - The client the app renders against.
   */
  restore(queryClient: QueryClient): void;
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
  const key = bootCacheStorageKey(apiBaseUrl);
  pruneForeignBootCaches(key, storage);

  const persister = createSyncStoragePersister({
    storage,
    key,
    throttleTime: SAVE_THROTTLE_MS,
  });

  // Read once. `restore` needs it synchronously and the provider asks for it
  // again a microtask later; handing back the same object spares a second parse
  // of the whole blob and makes the provider's own restore a no-op re-hydrate
  // (`hydrate` skips a query whose cached answer is not newer).
  let firstRead: PersistedClient | undefined = readPersistedClient(storage, key);
  let firstReadConsumed = false;

  return {
    restore(queryClient) {
      if (firstRead === undefined) return;
      if (!isUsable(firstRead, buster)) {
        storage.removeItem(key);
        firstRead = undefined;
        return;
      }
      hydrate(queryClient, firstRead.clientState);
    },
    persistOptions: {
      maxAge: BOOT_CACHE_MAX_AGE_MS,
      buster,
      dehydrateOptions: {
        shouldDehydrateQuery: (query) =>
          isBootQueryKey(query.queryKey) &&
          defaultShouldDehydrateQuery(query as Parameters<typeof defaultShouldDehydrateQuery>[0]),
      },
      persister: {
        persistClient: (client) => persister.persistClient(client),
        removeClient: () => persister.removeClient(),
        restoreClient: () => {
          if (!firstReadConsumed) {
            firstReadConsumed = true;
            return Promise.resolve(firstRead);
          }
          return Promise.resolve(persister.restoreClient());
        },
      },
    },
  };
}
