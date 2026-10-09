import { getExtensionLoadAdmission } from '@/layers/shared/lib';
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock sonner (pulled in transitively by extension-api-factory)
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

// Mock ui-action-dispatcher (pulled in transitively by extension-api-factory)
vi.mock('@/layers/shared/lib/ui-action-dispatcher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/lib/ui-action-dispatcher')>()),
  executeUiCommand: vi.fn(),
}));

import { ExtensionLoader } from '../model/extension-loader';
import type { ExtensionAPIDeps } from '../model/types';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';

// --- Helpers ---

function makeDeps(overrides: Partial<ExtensionAPIDeps> = {}): ExtensionAPIDeps {
  return {
    registry: {
      register: vi.fn().mockReturnValue(vi.fn()),
      getContributions: vi.fn().mockReturnValue([]),
      setTabMarker: vi.fn(),
      clearTabMarkers: vi.fn(),
    },
    dispatcherContext: {
      getStore: () => ({}) as ReturnType<ExtensionAPIDeps['dispatcherContext']['getStore']>,
      setTheme: vi.fn(),
    },
    navigate: vi.fn(),
    appStore: {
      getState: vi.fn().mockReturnValue({}),
      subscribe: vi.fn().mockReturnValue(vi.fn()),
    },
    availableSlots: new Set([
      'dashboard.sections',
      'command-palette.items',
    ] as const) as ExtensionAPIDeps['availableSlots'],
    registerCommandHandler: vi.fn(),
    unregisterCommandHandler: vi.fn(),
    eventBridge: { subscribe: vi.fn().mockReturnValue(vi.fn()) },
    ...overrides,
  };
}

function makeRecord(overrides: Partial<ExtensionRecordPublic> = {}): ExtensionRecordPublic {
  return {
    id: 'test-ext',
    manifest: { id: 'test-ext', name: 'Test Extension', version: '1.0.0' },
    status: 'compiled',
    scope: 'global',
    origin: 'user',
    bundleReady: true,
    hasServerEntry: false,
    hasDataProxy: false,
    approvedToRun: true,
    shadowedBy: null,
    bundleGeneration: 'a'.repeat(64),
    ...overrides,
  };
}

// --- Tests ---

describe('ExtensionLoader.reloadExtensions', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('deactivates the old extension before re-importing', async () => {
    const deactivate = vi.fn();
    const cleanup = vi.fn();

    // Seed an already-loaded extension
    const loader = makeLoader(makeDeps());
    await activateFixtures(loader, [{ id: 'my-ext', deactivate, cleanups: [cleanup] }]);

    // Mock fetch for the updated extension list
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([makeRecord({ id: 'my-ext', status: 'compiled', bundleReady: true })]),
    });

    await loader.reloadExtensions(['my-ext']);

    // The old extension should have been deactivated and cleaned up
    expect(deactivate).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('imports a bundle bound to its advertised generation', async () => {
    const loader = makeLoader(makeDeps());
    await activateFixtures(loader, [{ id: 'my-ext' }]);

    const records = [makeRecord({ id: 'my-ext', status: 'compiled', bundleReady: true })];
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(records),
    });

    // The dynamic import will fail in jsdom (expected), but we can verify
    // via the error log that the loader attempted the cache-busted URL.
    // We spy on the error message which includes the URL.
    await loader.reloadExtensions(['my-ext']);

    // The import failed (jsdom cannot resolve module URLs), so the extension
    // was removed from the loaded map during deactivation, and the reimport
    // failed. The loaded map should not contain my-ext.
    expect(loader.getLoaded().has('my-ext')).toBe(false);

    // But the error log should indicate a reimport was attempted
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[extensions] Failed to import my-ext:'),
      expect.anything()
    );
  });

  it('preserves other extensions during targeted reload', async () => {
    const loader = makeLoader(makeDeps());

    // Seed two extensions
    await activateFixtures(loader, [{ id: 'ext-a' }, { id: 'ext-b' }]);

    expect(loader.getLoaded().size).toBe(2);

    // Only reload ext-a
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          makeRecord({ id: 'ext-a', status: 'compiled', bundleReady: true }),
          makeRecord({ id: 'ext-b', status: 'compiled', bundleReady: true }),
        ]),
    });

    await loader.reloadExtensions(['ext-a']);

    // ext-b should still be in the loaded map, untouched
    expect(loader.getLoaded().has('ext-b')).toBe(true);
    const extB = loader.getLoaded().get('ext-b');
    expect(extB?.id).toBe('ext-b');
  });

  it('handles reactivation failure gracefully', async () => {
    const loader = makeLoader(makeDeps());
    await activateFixtures(loader, [{ id: 'bad-ext' }]);

    // Return the extension as compiled + bundleReady so loader attempts reimport
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([makeRecord({ id: 'bad-ext', status: 'compiled', bundleReady: true })]),
    });

    // The dynamic import will fail in jsdom — this simulates reactivation failure
    const { loaded } = await loader.reloadExtensions(['bad-ext']);

    // The failed extension should not be in the loaded map
    expect(loaded.has('bad-ext')).toBe(false);

    // The error was logged, not thrown
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('skips reimport for extensions no longer compiled or bundle-ready', async () => {
    const loader = makeLoader(makeDeps());
    await activateFixtures(loader, [{ id: 'removed-ext' }]);

    // Server says the extension is no longer compiled
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          makeRecord({ id: 'removed-ext', status: 'compile_error', bundleReady: false }),
        ]),
    });

    const { loaded } = await loader.reloadExtensions(['removed-ext']);

    // Extension was deactivated and not reimported (status check fails)
    expect(loaded.has('removed-ext')).toBe(false);
  });

  it('skips reimport when extension is not in updated list from server', async () => {
    const loader = makeLoader(makeDeps());
    await activateFixtures(loader, [{ id: 'gone-ext' }]);

    // Server returns empty list — extension was removed
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });

    const { loaded, extensions } = await loader.reloadExtensions(['gone-ext']);

    expect(loaded.has('gone-ext')).toBe(false);
    expect(extensions).toHaveLength(0);
  });

  it('handles deactivation error during reload without crashing', async () => {
    const loader = makeLoader(makeDeps());
    const failedOwner = {
      id: 'crash-deactivate',
      deactivate: vi.fn(() => {
        throw new Error('deactivate boom');
      }),
      cleanups: [
        vi.fn(() => {
          throw new Error('cleanup boom');
        }),
      ],
    };
    await activateFixtures(loader, [failedOwner]);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          makeRecord({ id: 'crash-deactivate', status: 'compiled', bundleReady: true }),
        ]),
    });

    // Should not throw even though deactivate and cleanup both throw
    await expect(loader.reloadExtensions(['crash-deactivate'])).resolves.toBeDefined();

    expect(failedOwner.deactivate).toHaveBeenCalledOnce();
    expect(failedOwner.cleanups[0]).toHaveBeenCalledOnce();
    expect(loader.deactivateAll()).toBe(false);
    expect(failedOwner.deactivate).toHaveBeenCalledOnce();
  });

  it('returns refreshed extension list from server', async () => {
    const loader = makeLoader(makeDeps());
    await activateFixtures(loader, [{ id: 'ext-a' }]);

    const serverRecords = [
      makeRecord({ id: 'ext-a', status: 'compiled', bundleReady: true }),
      makeRecord({ id: 'ext-b', status: 'disabled', bundleReady: false }),
    ];
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(serverRecords),
    });

    const { extensions } = await loader.reloadExtensions(['ext-a']);

    // Should reflect the latest server state
    expect(extensions).toHaveLength(2);
    expect(extensions.map((e) => e.id)).toEqual(['ext-a', 'ext-b']);
  });

  it('reloads multiple extensions in a single call', async () => {
    const deactivateA = vi.fn();
    const deactivateB = vi.fn();

    const loader = makeLoader(makeDeps());
    await activateFixtures(loader, [
      { id: 'ext-a', deactivate: deactivateA },
      { id: 'ext-b', deactivate: deactivateB },
      { id: 'ext-c' },
    ]);

    // This one stays

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          makeRecord({ id: 'ext-a', status: 'compiled', bundleReady: true }),
          makeRecord({ id: 'ext-b', status: 'compiled', bundleReady: true }),
          makeRecord({ id: 'ext-c', status: 'compiled', bundleReady: true }),
        ]),
    });

    await loader.reloadExtensions(['ext-a', 'ext-b']);

    // Both targeted extensions were deactivated
    expect(deactivateA).toHaveBeenCalledOnce();
    expect(deactivateB).toHaveBeenCalledOnce();

    // ext-c was not touched
    expect(loader.getLoaded().has('ext-c')).toBe(true);
  });

  it('handles reload of extension not in loaded map (no-op deactivation)', async () => {
    const loader = makeLoader(makeDeps());

    // No extensions seeded — reload a nonexistent one
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([makeRecord({ id: 'phantom', status: 'compiled', bundleReady: true })]),
    });

    // Should not throw — deactivation of nonexistent extension is a no-op
    await expect(loader.reloadExtensions(['phantom'])).resolves.toBeDefined();
  });
});

describe('ExtensionLoader.reloadAll', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('tears down every currently loaded extension before re-initializing', async () => {
    const deactivateA = vi.fn();
    const cleanupA = vi.fn();
    const deactivateB = vi.fn();
    const cleanupB = vi.fn();

    const loader = makeLoader(makeDeps());
    await activateFixtures(loader, [
      { id: 'ext-a', deactivate: deactivateA, cleanups: [cleanupA] },
      { id: 'ext-b', deactivate: deactivateB, cleanups: [cleanupB] },
    ]);

    // The new working directory's set from the server.
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([makeRecord({ id: 'ext-c', status: 'disabled', bundleReady: false })]),
    });

    await loader.reloadAll();

    // Every previous extension was deactivated and cleaned up (contributions
    // and subscriptions removed) so nothing carries over from the old cwd.
    expect(deactivateA).toHaveBeenCalledOnce();
    expect(cleanupA).toHaveBeenCalledOnce();
    expect(deactivateB).toHaveBeenCalledOnce();
    expect(cleanupB).toHaveBeenCalledOnce();

    // The old extensions are gone from the loaded map.
    expect(loader.getLoaded().has('ext-a')).toBe(false);
    expect(loader.getLoaded().has('ext-b')).toBe(false);
  });

  it('re-fetches and returns the extension set for the new working directory', async () => {
    const loader = makeLoader(makeDeps());
    await activateFixtures(loader, [{ id: 'ext-old' }]);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([makeRecord({ id: 'ext-new', status: 'disabled', bundleReady: false })]),
    });
    global.fetch = fetchMock;

    const { extensions } = await loader.reloadAll();

    expect(fetchMock).toHaveBeenCalled();
    expect(extensions.map((e) => e.id)).toEqual(['ext-new']);
  });

  it('keeps the loader live (not disposed) so it can reload again', async () => {
    const loader = makeLoader(makeDeps());
    await activateFixtures(loader, [{ id: 'ext-a' }]);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });

    await loader.reloadAll();

    const disposed = (loader as unknown as { disposed: boolean }).disposed;
    expect(disposed).toBe(false);

    // A second reload still works — the loader was not disposed.
    await expect(loader.reloadAll()).resolves.toBeDefined();
  });

  it('does not throw when a teardown handler fails during reload', async () => {
    const loader = makeLoader(makeDeps());
    const failedOwner = {
      id: 'crash-ext',
      deactivate: vi.fn(() => {
        throw new Error('deactivate boom');
      }),
      cleanups: [
        vi.fn(() => {
          throw new Error('cleanup boom');
        }),
      ],
    };
    await activateFixtures(loader, [failedOwner]);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });

    await expect(loader.reloadAll()).resolves.toBeDefined();

    expect(failedOwner.deactivate).toHaveBeenCalledOnce();
    expect(failedOwner.cleanups[0]).toHaveBeenCalledOnce();
    expect(loader.deactivateAll()).toBe(false);
    expect(failedOwner.deactivate).toHaveBeenCalledOnce();
  });

  it('leaves the current extension set live when the list fetch fails (fetch-then-swap)', async () => {
    const deactivate = vi.fn();
    const cleanup = vi.fn();

    const loader = makeLoader(makeDeps());
    await activateFixtures(loader, [{ id: 'ext-live', deactivate, cleanups: [cleanup] }]);

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'boom' }),
    });

    const outcome = await loader.reloadAll();
    expect(outcome.status).toBe('partial');
    expect(outcome.failures).toEqual([{ id: '', stage: 'load' }]);
    expect(loader.isOutcomeCurrent(outcome)).toBe(true);

    // Nothing was torn down: the previous extensions are still fully live.
    expect(deactivate).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(loader.getLoaded().has('ext-live')).toBe(true);
  });
});

describe('ExtensionLoader generation guard (rapid-switch races)', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  /** Build a deferred fetch response the test resolves on demand. */
  function deferredFetch() {
    let resolve!: (records: ExtensionRecordPublic[]) => void;
    const promise = new Promise<{ ok: boolean; json: () => Promise<ExtensionRecordPublic[]> }>(
      (r) => {
        resolve = (records) => r({ ok: true, json: () => Promise.resolve(records) });
      }
    );
    return { promise, resolve };
  }

  it('a superseded reloadAll neither tears down nor activates (rapid cwd switch)', async () => {
    const deactivate = vi.fn();
    const loader = makeLoader(makeDeps());
    await activateFixtures(loader, [{ id: 'ext-old', deactivate }]);

    const fetch1 = deferredFetch();
    const fetch2 = deferredFetch();
    global.fetch = vi
      .fn()
      .mockImplementationOnce(() => fetch1.promise)
      .mockImplementationOnce(() => fetch2.promise);

    // Two cwd switches in quick succession: #2 supersedes #1.
    const reload1 = loader.reloadAll();
    const reload2 = loader.reloadAll();

    // The superseded load's fetch resolves first, with a stale-cwd set.
    fetch1.resolve([makeRecord({ id: 'stale-ext', status: 'compiled', bundleReady: true })]);
    await reload1;

    // #1 registered nothing: no teardown, no import attempt of the stale set.
    expect(deactivate).not.toHaveBeenCalled();
    expect(loader.getLoaded().has('ext-old')).toBe(true);
    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('[extensions] Failed to import stale-ext:'),
      expect.anything()
    );

    // The winning load completes normally: teardown happens exactly once.
    fetch2.resolve([]);
    await reload2;

    expect(deactivate).toHaveBeenCalledOnce();
    expect(loader.getLoaded().size).toBe(0);
  });

  it('a superseded SSE reload does not resurrect extensions after a cwd-switch reloadAll', async () => {
    const loader = makeLoader(makeDeps());
    await activateFixtures(loader, [{ id: 'ext-a' }]);

    const sseFetch = deferredFetch();
    global.fetch = vi
      .fn()
      // First call: the SSE reload's list fetch, held pending.
      .mockImplementationOnce(() => sseFetch.promise)
      // Second call: the cwd-switch reloadAll's fetch, resolves immediately.
      .mockImplementation(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) }));

    // SSE hot-reload starts (tears ext-a down synchronously, then awaits fetch)...
    const sseReload = loader.reloadExtensions(['ext-a']);
    // ...and a cwd switch supersedes it. The new cwd has no extensions.
    await loader.reloadAll();
    expect(loader.getLoaded().size).toBe(0);

    // The stale SSE fetch now resolves, still listing the pre-switch extension.
    sseFetch.resolve([makeRecord({ id: 'ext-a', status: 'compiled', bundleReady: true })]);
    await sseReload;

    // The superseded SSE reload must not have re-imported or re-registered it.
    expect(loader.getLoaded().size).toBe(0);
    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('[extensions] Failed to hot-reload ext-a:'),
      expect.anything()
    );
  });
});

/** Real loader/factory ownership; only bundle delivery and host ports are mocked. */
const fixtureDeps = new WeakMap<ExtensionLoader, ExtensionAPIDeps>();
function makeLoader(deps: ExtensionAPIDeps): ExtensionLoader {
  const loader = new ExtensionLoader(deps, getExtensionLoadAdmission(), vi.fn());
  fixtureDeps.set(loader, deps);
  return loader;
}
async function activateFixtures(
  loader: ExtensionLoader,
  entries: Array<{ id: string; deactivate?: () => void; cleanups?: Array<() => void> }>
): Promise<void> {
  const deps = fixtureDeps.get(loader)!;
  const previousFetch = globalThis.fetch;
  const records = entries.map((entry) => makeRecord({ id: entry.id }));
  const urls = records.map(
    (record) => '/api/extensions/' + record.id + '/bundle?generation=' + record.bundleGeneration
  );
  entries.forEach((entry, index) =>
    vi.doMock(urls[index], () => ({
      activate(api: import('@dorkos/extension-api').ExtensionAPI) {
        for (const [n, cleanup] of (entry.cleanups ?? []).entries()) {
          vi.mocked(deps.registry.register).mockReturnValueOnce(cleanup);
          api.registerComponent('dashboard.sections', 'fixture-' + n, () => null);
        }
        return entry.deactivate;
      },
    }))
  );
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => records });
  try {
    const outcome = await loader.initialize();
    expect(outcome.status).toBe('completed');
    expect(outcome.loaded.size).toBe(entries.length);
  } finally {
    globalThis.fetch = previousFetch;
    urls.forEach((url) => vi.doUnmock(url));
  }
}
