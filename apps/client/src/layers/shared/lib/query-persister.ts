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
 * **Why it is not on `shared/lib`'s barrel.** Building a cache means deciding
 * whether this surface may have one, and that decision is `instanceof
 * HttpTransport` — so this module loads the whole HTTP transport. Re-exported
 * from the barrel, it put the client-server seam in the module graph of every
 * `import { cn }` in the app (DOR-1809). The app root and the two specs that
 * drive a real cache import `@/layers/shared/lib/query-persister` directly; the
 * key and allow-list halves, which need no transport, moved to
 * `./boot-cache-keys` and are still on the barrel for sign-out and the Dev
 * Playground.
 *
 * @module shared/lib/query-persister
 */
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { defaultShouldDehydrateQuery, dehydrate, type QueryClient } from '@tanstack/react-query';
import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';

import type { Transport } from '@dorkos/shared/transport';

import { HttpTransport } from './transport';
import {
  BOOT_CACHE_DISABLED_KEY,
  BOOT_CACHE_MAX_AGE_MS,
  bootCacheStorageKey,
  isBootQueryKey,
  pruneForeignBootCaches,
} from './boot-cache-keys';

/**
 * How long the writer waits before saving again.
 *
 * The save runs on every cache event, and boot alone produces dozens. One
 * serialize per second is invisible to the operator and keeps a
 * `JSON.stringify` of the whole allow-list off the frames that matter.
 */
const SAVE_THROTTLE_MS = 1_000;

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
  // Both halves, because `hydrate` reads both: the key it builds the query
  // under, and `state.data` / `state.dataUpdatedAt` off the entry. An entry
  // carrying a key and no state parses, passes a key-only check, and throws
  // inside the restore.
  return state.queries.every((query) => {
    if (typeof query !== 'object' || query === null) return false;
    const entry = query as { queryKey?: unknown; state?: unknown };
    if (!Array.isArray(entry.queryKey)) return false;
    return typeof entry.state === 'object' && entry.state !== null;
  });
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
 * Claim this cockpit's slot in browser storage, or decide there is none.
 *
 * **Every line in here can throw in a browser we do not control.** Reading
 * `window.localStorage` raises a `SecurityError` where storage is blocked (a
 * sandboxed frame, a locked-down profile); `getItem` and the prune's iteration
 * can throw for the same reason; and `new URL(apiBaseUrl, origin)` throws
 * outright when the origin is not one — a page the browser gives an opaque
 * origin reports the literal string `"null"`. The desktop shell normally serves
 * the cockpit from `http://localhost:<port>`, but its last-resort path
 * (`loadFile` of the built `index.html`, in `window-manager.ts`) is a `file://`
 * page, and that is exactly the moment nothing else is going right either.
 *
 * None of that may escape, because {@link createBootCache} is called at MODULE
 * SCOPE in `main.tsx`, before React exists and outside every error boundary.
 * A throw there is not a degraded cockpit, it is a blank window — the shape of
 * failure v0.63.0 shipped for a different reason (DOR-1448). Booting cold is a
 * first paint with skeletons; there is no version of this worth a black screen.
 *
 * @param provided - The caller's storage, if it passed one.
 * @param apiBaseUrl - The base URL the entry is keyed by.
 * @returns The storage and the key to use, or `null` to boot with no memory.
 */
function claimStorageSlot(
  provided: Storage | undefined,
  apiBaseUrl: string
): { storage: Storage; key: string } | null {
  try {
    const storage = provided ?? window.localStorage;
    // Switched off for this session — see {@link BOOT_CACHE_DISABLED_KEY}.
    // Checked before anything is read, written or pruned, so a disabled session
    // leaves the storage exactly as it found it.
    if (storage.getItem(BOOT_CACHE_DISABLED_KEY) !== null) return null;
    const key = bootCacheStorageKey(apiBaseUrl);
    pruneForeignBootCaches(key, storage);
    return { storage, key };
  } catch (err) {
    console.error('[dorkos] This browser has no usable local memory; booting cold.', err);
    return null;
  }
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
 * @returns The cache, or `null` when this surface must not persist — or cannot,
 *   see {@link claimStorageSlot}. Never throws: the caller runs at module scope.
 */
export function createBootCache(options: {
  transport: Transport;
  apiBaseUrl: string;
  buster: string;
  storage?: Storage;
}): BootCache | null {
  const { transport, apiBaseUrl, buster } = options;
  if (!(transport instanceof HttpTransport)) return null;

  const claimed = claimStorageSlot(options.storage, apiBaseUrl);
  if (claimed === null) return null;
  const { storage, key } = claimed;

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
