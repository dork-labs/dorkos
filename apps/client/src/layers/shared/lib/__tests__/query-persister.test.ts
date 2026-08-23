import { describe, it, expect, beforeEach, vi } from 'vitest';
import { dehydrate, QueryClient } from '@tanstack/react-query';
import { persistQueryClientRestore } from '@tanstack/react-query-persist-client';
import {
  BOOT_CACHE_DISABLED_KEY,
  BOOT_CACHE_KEY_PREFIX,
  BOOT_CACHE_MAX_AGE_MS,
  bootCacheStorageKey,
  clearBootCache,
  createBootCache,
  isBootQueryKey,
} from '../query-persister';
// The real factory rather than the literal — the allow-list in
// `query-persister.ts` has to spell these keys by hand (`shared/` may not import
// an entity), so the table below is only a drift guard if one side of it is the
// definition. It is also the rule `__tests__/one-config-query-key.test.ts`
// enforces: `['config','current']` may be written in exactly one file.
import { configKeys } from '../../model/server-config/query-keys';
import { HttpTransport } from '../transport';
import { DirectTransport } from '../direct-transport';
import type { Transport } from '@dorkos/shared/transport';

/** A `Storage` that lives in a plain object, so each test starts from nothing. */
function fakeStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage;
}

/** One persisted blob, as the persister writes it. */
function blob(options: {
  buster: string;
  timestamp?: number;
  queries?: { queryKey: readonly unknown[]; data: unknown }[];
}): string {
  return JSON.stringify({
    buster: options.buster,
    timestamp: options.timestamp ?? Date.now(),
    clientState: {
      mutations: [],
      queries: (options.queries ?? []).map((q) => ({
        queryKey: q.queryKey,
        queryHash: JSON.stringify(q.queryKey),
        state: { data: q.data, dataUpdatedAt: Date.now(), status: 'success', fetchStatus: 'idle' },
      })),
    },
  });
}

const BUSTER = '1.2.3';

/**
 * Long enough for the persister's one-second write throttle to have fired.
 *
 * Real timers rather than fake ones: the throttle lives inside
 * `createSyncStoragePersister`, which captured `setTimeout` at module load, so
 * `vi.useFakeTimers()` here would swap a clock the code under test is not
 * holding and prove nothing (see the fake-timer entry in `.claude/rules/testing.md`).
 */
const SAVE_THROTTLE_WAIT_MS = 1_500;

describe('the sidebar’s local memory', () => {
  describe('what it is allowed to remember', () => {
    it.each([
      ['the config the panel is arranged by', configKeys.current()],
      ['the room list', ['rooms', 'list', null]],
      ['the room list filtered to one kind', ['rooms', 'list', 'channel']],
      ['today’s threads', ['rooms', 'threads']],
      ['where the fleet’s agents live', ['mesh', 'agent-paths']],
      ['every agent’s real name and face', ['agents', 'resolved', '/a', '/b']],
      ['the recent-sessions window', ['recent-sessions', 24]],
      ['the team roster', ['team']],
    ])('remembers %s', (_what, key) => {
      expect(isBootQueryKey(key)).toBe(true);
    });

    it.each([
      // The three Heads up sources. Deliberately cold: a stale "three things
      // need you" that resolves to zero is a confident lie, and the boot gate’s
      // 1500 ms ceiling means a cold one cannot hold the reveal shut.
      ['tool approvals waiting on a person', ['approvals', 'pending']],
      ['questions an agent parked on', ['interactions', 'pending']],
      ['scheduled runs waiting for a yes', ['schedule-approvals', 'pending']],
      // A conversation belongs to the transcript store, never to localStorage.
      ['a room’s history', ['rooms', 'entries', 'room-1']],
      ['one session’s transcript', ['sessions', 'detail', 's-1', '/repo']],
      // Same head, different question — the archived-inclusive list is the
      // command palette’s, and one member’s rooms are not the roster.
      ['the archived-inclusive room list', ['rooms', 'list', 'with-archived', null]],
      ['one member’s rooms', ['team', 'rooms', 'm-1']],
      // A prefix that is not a key.
      ['the bare room root', ['rooms']],
      ['the bare config root', configKeys.all],
    ])('does not remember %s', (_what, key) => {
      expect(isBootQueryKey(key)).toBe(false);
    });
  });

  describe('the key it is kept under', () => {
    beforeEach(() => {
      vi.stubGlobal('location', { origin: 'http://localhost:6241' } as Location);
    });

    it('names the origin that answers, so two cockpits never share a memory', () => {
      expect(bootCacheStorageKey('/api')).toBe(`${BOOT_CACHE_KEY_PREFIX}http://localhost:6241`);
      expect(bootCacheStorageKey('http://localhost:4242/api')).toBe(
        `${BOOT_CACHE_KEY_PREFIX}http://localhost:4242`
      );
    });
  });

  describe('which surfaces keep one', () => {
    it('keeps one for the web cockpit', () => {
      const cache = createBootCache({
        transport: new HttpTransport('/api'),
        apiBaseUrl: '/api',
        buster: BUSTER,
        storage: fakeStorage(),
      });
      expect(cache).not.toBeNull();
    });

    it('keeps none when a session has switched local memory off', () => {
      const storage = fakeStorage({
        [BOOT_CACHE_DISABLED_KEY]: '1',
        [`${BOOT_CACHE_KEY_PREFIX}http://other`]: '{}',
      });

      const cache = createBootCache({
        transport: new HttpTransport('/api'),
        apiBaseUrl: '/api',
        buster: BUSTER,
        storage,
      });

      expect(cache).toBeNull();
      // And it left the storage exactly as it found it — no prune, no write. A
      // disabled session must be indistinguishable from one that never ran.
      expect(storage.getItem(`${BOOT_CACHE_KEY_PREFIX}http://other`)).toBe('{}');
    });

    it('spells the opt-out key the browser suite hardcodes', () => {
      // `apps/e2e/fixtures/index.ts` writes this exact string on every context to
      // keep the suite's world cold, and `boot-stability.spec.ts` removes it to
      // opt in. apps/e2e depends on no workspace package, so the two cannot share
      // a constant — this is the pin that makes a rename loud.
      expect(BOOT_CACHE_DISABLED_KEY).toBe('dorkos:boot-cache-disabled');
    });

    it('keeps none when the browser refuses to hand over its storage', () => {
      // Blocked storage raises a SecurityError on ACCESS — a locked-down
      // profile, a sandboxed frame. This runs at module scope in `main.tsx`,
      // outside every error boundary, so a throw here is a window that never
      // paints. Cold is the only acceptable answer.
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const hostile = {
        get length(): number {
          throw new Error('The operation is insecure.');
        },
        key: () => null,
        getItem: () => {
          throw new Error('The operation is insecure.');
        },
        setItem: () => {},
        removeItem: () => {},
        clear: () => {},
      } as Storage;

      const cache = createBootCache({
        transport: new HttpTransport('/api'),
        apiBaseUrl: '/api',
        buster: BUSTER,
        storage: hostile,
      });

      expect(cache).toBeNull();
      expect(logged).toHaveBeenCalled();
    });

    it('keeps none when the page has no origin to key one by', () => {
      // A page with an opaque origin reports the literal string "null", and
      // `new URL('/api', 'null')` throws. The desktop shell reaches that only
      // on its `loadFile` last resort, which is precisely when a blank window
      // is least affordable. Same module scope, same blank window.
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubGlobal('location', { origin: 'null' } as Location);

      const cache = createBootCache({
        transport: new HttpTransport('/api'),
        apiBaseUrl: '/api',
        buster: BUSTER,
        storage: fakeStorage(),
      });

      expect(cache).toBeNull();
      expect(logged).toHaveBeenCalled();
    });

    it('keeps none for the Obsidian embed, whose server is in the same process', () => {
      // The embed’s transport needs no services to answer this question — the
      // decision is made on the transport’s identity, before a call is made.
      const embed = new DirectTransport({} as never) as unknown as Transport;
      const storage = fakeStorage({ [`${BOOT_CACHE_KEY_PREFIX}http://x`]: '{}' });

      const cache = createBootCache({
        transport: embed,
        apiBaseUrl: '/api',
        buster: BUSTER,
        storage,
      });

      expect(cache).toBeNull();
      // …and it did not touch what was already there on its way out.
      expect(storage.getItem(`${BOOT_CACHE_KEY_PREFIX}http://x`)).toBe('{}');
    });
  });

  describe('restoring', () => {
    beforeEach(() => {
      vi.stubGlobal('location', { origin: 'http://localhost:6241' } as Location);
    });

    /** Build a cache over one storage, for this origin. */
    function cacheOver(storage: Storage, buster = BUSTER) {
      return createBootCache({
        transport: new HttpTransport('/api'),
        apiBaseUrl: '/api',
        buster,
        storage,
      })!;
    }

    const KEY = `${BOOT_CACHE_KEY_PREFIX}http://localhost:6241`;

    /**
     * Restore the way the app really does — through the library's own path.
     *
     * `PersistQueryClientProvider` calls exactly this, so driving it here means
     * the buster and max-age rules are tested where they are ENFORCED (in
     * `persistQueryClientRestore`) rather than against a second copy of them
     * written to make the test pass.
     */
    async function restoreThrough(storage: Storage, buster = BUSTER) {
      const queryClient = new QueryClient();
      const cache = cacheOver(storage, buster);
      await persistQueryClientRestore({ queryClient, ...cache.persistOptions });
      return queryClient;
    }

    it('paints the remembered answers into the cache', async () => {
      const storage = fakeStorage({
        [KEY]: blob({
          buster: BUSTER,
          queries: [{ queryKey: configKeys.current(), data: { version: '1.2.3' } }],
        }),
      });

      const queryClient = await restoreThrough(storage);

      expect(queryClient.getQueryState(configKeys.current())?.dataUpdatedAt).toBeGreaterThan(0);
    });

    it('throws away a blob from another build rather than painting yesterday’s shape', async () => {
      const storage = fakeStorage({
        [KEY]: blob({
          buster: '0.0.1',
          queries: [{ queryKey: configKeys.current(), data: { version: '0.0.1' } }],
        }),
      });

      const queryClient = await restoreThrough(storage, BUSTER);

      expect(queryClient.getQueryState(configKeys.current())).toBeUndefined();
      expect(storage.getItem(KEY)).toBeNull();
    });

    it('throws away a blob older than a day', async () => {
      const storage = fakeStorage({
        [KEY]: blob({
          buster: BUSTER,
          timestamp: Date.now() - BOOT_CACHE_MAX_AGE_MS - 1,
          queries: [{ queryKey: ['team'], data: [] }],
        }),
      });

      const queryClient = await restoreThrough(storage);

      expect(queryClient.getQueryState(['team'])).toBeUndefined();
      expect(storage.getItem(KEY)).toBeNull();
    });

    /**
     * Blobs that are well-formed JSON and still not a cache.
     *
     * **`localStorage` is a shared, writable namespace.** A browser extension, a
     * previous build, a write cut off by a crashing tab, or a person in devtools
     * can leave any of these behind, and `hydrate` walks straight into the ones
     * that parse. Each must end as a cold boot with the key gone — never a
     * thrown error, and never a hydrate attempt.
     */
    const POISON: [name: string, raw: string][] = [
      ['not JSON at all', 'not json'],
      ['JSON that is not an object', '"just a string"'],
      ['null', 'null'],
      ['no clientState', JSON.stringify({ buster: BUSTER, timestamp: Date.now() })],
      [
        'garbage-queries — queries is not an array',
        JSON.stringify({
          buster: BUSTER,
          timestamp: Date.now(),
          clientState: { mutations: [], queries: 'garbage' },
        }),
      ],
      [
        'query-not-object — an entry hydrate would read fields off',
        JSON.stringify({
          buster: BUSTER,
          timestamp: Date.now(),
          clientState: { mutations: [], queries: [null] },
        }),
      ],
      [
        'a query with no queryKey',
        JSON.stringify({
          buster: BUSTER,
          timestamp: Date.now(),
          clientState: { mutations: [], queries: [{ state: { data: 1 } }] },
        }),
      ],
      [
        // `hydrate` reads `state.data` and `state.dataUpdatedAt` off every
        // entry, so a key on its own is not enough to hydrate from.
        'a query with a key and no state',
        JSON.stringify({
          buster: BUSTER,
          timestamp: Date.now(),
          clientState: { mutations: [], queries: [{ queryKey: ['team'] }] },
        }),
      ],
      [
        'a query whose state is not an object',
        JSON.stringify({
          buster: BUSTER,
          timestamp: Date.now(),
          clientState: { mutations: [], queries: [{ queryKey: ['team'], state: 'ready' }] },
        }),
      ],
      [
        'a timestamp that is not a number',
        JSON.stringify({
          buster: BUSTER,
          timestamp: 'yesterday',
          clientState: { mutations: [], queries: [] },
        }),
      ],
    ];

    it.each(POISON)('boots cold and forgets the blob: %s', async (_name, raw) => {
      const storage = fakeStorage({ [KEY]: raw });

      const queryClient = await restoreThrough(storage);

      expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
      expect(storage.getItem(KEY)).toBeNull();
    });

    it('drops another cockpit’s memory rather than leaving it behind forever', () => {
      const foreign = `${BOOT_CACHE_KEY_PREFIX}http://localhost:9999`;
      const storage = fakeStorage({
        [foreign]: blob({ buster: BUSTER }),
        'unrelated:key': 'keep me',
      });

      cacheOver(storage);

      expect(storage.getItem(foreign)).toBeNull();
      expect(storage.getItem('unrelated:key')).toBe('keep me');
    });
  });

  describe('what it writes', () => {
    beforeEach(() => {
      vi.stubGlobal('location', { origin: 'http://localhost:6241' } as Location);
    });

    it('writes the allow-list and nothing else', async () => {
      const storage = fakeStorage();
      const cache = createBootCache({
        transport: new HttpTransport('/api'),
        apiBaseUrl: '/api',
        buster: BUSTER,
        storage,
      })!;
      const queryClient = new QueryClient();
      // One member of the list, one query that is not — both real answers in a
      // real cache, so what is proved is the write and not the predicate again.
      queryClient.setQueryData(['rooms', 'list', null], [{ id: 'r1' }]);
      queryClient.setQueryData(['rooms', 'entries', 'r1'], [{ id: 'e1', text: 'a secret' }]);

      const written = JSON.stringify(dehydrate(queryClient, cache.persistOptions.dehydrateOptions));

      expect(written).toContain('"rooms","list"');
      expect(written).not.toContain('a secret');
      expect(written).not.toContain('entries');
    });

    it('reaches the storage under this cockpit’s key', async () => {
      const storage = fakeStorage();
      const cache = createBootCache({
        transport: new HttpTransport('/api'),
        apiBaseUrl: '/api',
        buster: BUSTER,
        storage,
      })!;

      // Something worth remembering, or the empty-write guard would (rightly)
      // leave no key at all and this would be asserting the wrong thing.
      const queryClient = new QueryClient();
      queryClient.setQueryData(configKeys.current(), { userSettings: {} });

      await cache.persistOptions.persister.persistClient({
        buster: BUSTER,
        timestamp: Date.now(),
        clientState: dehydrate(queryClient, cache.persistOptions.dehydrateOptions),
      });

      // The write is throttled — a boot alone produces dozens of cache events,
      // and one serialize per second keeps a `JSON.stringify` of the whole
      // allow-list off the frames that matter. So it lands, but not this tick.
      await vi.waitFor(
        () =>
          expect(storage.getItem(`${BOOT_CACHE_KEY_PREFIX}http://localhost:6241`)).not.toBeNull(),
        { timeout: 5_000 }
      );
    });

    it('writes on the way out of the page, without waiting for the throttle', () => {
      const storage = fakeStorage();
      const cache = createBootCache({
        transport: new HttpTransport('/api'),
        apiBaseUrl: '/api',
        buster: BUSTER,
        storage,
      })!;
      const queryClient = new QueryClient();
      queryClient.setQueryData(configKeys.current(), { promosDismissed: ['mobile'] });

      // No `await`, no timer. This is the difference: a person who dismisses a
      // card and reloads within the second must not be shown the card again.
      cache.flush(queryClient);

      const written = storage.getItem(`${BOOT_CACHE_KEY_PREFIX}http://localhost:6241`);
      expect(written).toContain('promosDismissed');
    });

    it('does not recreate the key after a sign-out has cleared it', async () => {
      const storage = fakeStorage();
      const cache = createBootCache({
        transport: new HttpTransport('/api'),
        apiBaseUrl: '/api',
        buster: BUSTER,
        storage,
      })!;
      const queryClient = new QueryClient();
      queryClient.setQueryData(configKeys.current(), { userSettings: {} });

      // Signing out drops the boot queries and wipes the storage — in that
      // order, as `useSignOut` does it.
      queryClient.removeQueries({ predicate: (query) => isBootQueryKey(query.queryKey) });
      clearBootCache(storage);

      // Dropping them was itself a cache event, so the throttled save fires up
      // to a second later. It must find nothing worth writing and leave no key
      // behind — otherwise the person is left holding an empty artefact of the
      // session they just ended.
      await cache.persistOptions.persister.persistClient({
        buster: BUSTER,
        timestamp: Date.now(),
        clientState: dehydrate(queryClient, cache.persistOptions.dehydrateOptions),
      });
      await new Promise((resolve) => setTimeout(resolve, SAVE_THROTTLE_WAIT_MS));

      expect(storage.getItem(`${BOOT_CACHE_KEY_PREFIX}http://localhost:6241`)).toBeNull();
    });

    it('does not write an empty memory on the way out of an emptied page', () => {
      const storage = fakeStorage({ [`${BOOT_CACHE_KEY_PREFIX}http://localhost:6241`]: 'stale' });
      const cache = createBootCache({
        transport: new HttpTransport('/api'),
        apiBaseUrl: '/api',
        buster: BUSTER,
        storage,
      })!;

      cache.flush(new QueryClient());

      expect(storage.getItem(`${BOOT_CACHE_KEY_PREFIX}http://localhost:6241`)).toBeNull();
    });

    it('forgets every cockpit when asked', () => {
      const storage = fakeStorage({
        [`${BOOT_CACHE_KEY_PREFIX}http://a`]: '{}',
        [`${BOOT_CACHE_KEY_PREFIX}http://b`]: '{}',
        'unrelated:key': 'keep me',
      });

      clearBootCache(storage);

      expect(storage.getItem(`${BOOT_CACHE_KEY_PREFIX}http://a`)).toBeNull();
      expect(storage.getItem(`${BOOT_CACHE_KEY_PREFIX}http://b`)).toBeNull();
      expect(storage.getItem('unrelated:key')).toBe('keep me');
    });
  });
});
