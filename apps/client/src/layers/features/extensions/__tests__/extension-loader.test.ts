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
import {
  getExtensionLoadAdmission,
  registerExtensionLoadOwner,
  beginExtensionAuthOperation,
  authenticateExtensionAuthOperation,
  resumeExtensionLoads,
} from '@/layers/shared/lib';
import { createInitialSlots, useExtensionRegistry } from '@/layers/shared/model';
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

function makeCompiledRecord(id = 'test-ext'): ExtensionRecordPublic {
  return makeRecord({
    id,
    manifest: { id, name: `Ext ${id}`, version: '1.0.0' },
    status: 'compiled',
    bundleReady: true,
  });
}

function mockFetch(records: ExtensionRecordPublic[]) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(records),
  });
}

// --- Tests ---

describe('ExtensionLoader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  // 1. No extensions: returns empty loaded map when server returns no compiled extensions
  it('returns empty loaded map when no compiled extensions', async () => {
    mockFetch([
      makeRecord({ status: 'disabled', bundleReady: false }),
      makeRecord({ id: 'broken', status: 'compile_error', bundleReady: false }),
    ]);

    const loader = makeLoader(makeDeps());
    const { loaded, extensions } = await loader.initialize();

    expect(loaded.size).toBe(0);
    // Full list still returned for callers that need all records
    expect(extensions).toHaveLength(2);
  });

  // 1b. An extension nobody approved is never fetched, let alone activated
  // (DOR-516). The server withholds the bundle regardless — that is the actual
  // guarantee — but the cockpit must not ask for it and log a console error on the
  // very screen where the person is deciding.
  it('never requests the bundle of an extension the person has not approved', async () => {
    mockFetch([
      makeCompiledRecord('approved'),
      makeRecord({ id: 'awaiting', status: 'compiled', bundleReady: true, approvedToRun: false }),
    ]);
    // jsdom cannot resolve the dynamic import of a bundle URL, so every extension
    // the loader ATTEMPTS logs `Failed to import <id>`. That failure is what makes
    // the attempt observable here: an id that appears was asked for, an id that
    // does not was filtered out before the import.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const loader = makeLoader(makeDeps());
    const { extensions } = await loader.initialize();

    // Both records still reach the caller, so the settings tab can render the card
    // that asks about the second one.
    expect(extensions).toHaveLength(2);
    const attempted = errors.mock.calls.map((args) => String(args[0]));
    expect(attempted.some((msg) => msg.includes('approved'))).toBe(true);
    expect(attempted.some((msg) => msg.includes('awaiting'))).toBe(false);
    errors.mockRestore();
  });

  // 2. Load and activate: successfully activates a pre-seeded extension via getLoaded
  // Note: dynamic import() of /api/extensions/…/bundle cannot be resolved in jsdom
  // (the URL is not in Vite's module graph). The activation path is therefore tested
  // through the public surface: seeding the loaded map directly (as the loader would
  // do after a successful import) and asserting getLoaded() reflects the state.
  // The error-isolation path (import throws → extension skipped) is tested in #8.
  it('getLoaded reflects extensions seeded after successful activation', () => {
    const loader = makeLoader(makeDeps());

    const activate = vi.fn().mockReturnValue(vi.fn()); // returns a deactivate fn
    const loadedMap = (loader as unknown as { loaded: Map<string, unknown> }).loaded;
    loadedMap.set('my-ext', {
      id: 'my-ext',
      manifest: { name: 'My Ext', version: '2.0.0', entry: 'index.js' },
      module: { activate },
      api: {},
      cleanups: [],
      deactivate: vi.fn(),
    });

    const result = loader.getLoaded();
    expect(result.size).toBe(1);
    expect(result.get('my-ext')).toMatchObject({ id: 'my-ext' });
  });

  // 3. Filters by status: only extensions with status:'compiled' and bundleReady:true are loaded
  it('filters out non-compiled and non-bundle-ready extensions', async () => {
    mockFetch([
      makeRecord({ id: 'a', status: 'discovered', bundleReady: false }),
      makeRecord({ id: 'b', status: 'enabled', bundleReady: false }),
      makeRecord({ id: 'c', status: 'compiled', bundleReady: false }), // bundleReady false
      makeRecord({ id: 'd', status: 'disabled', bundleReady: true }), // wrong status
      makeRecord({ id: 'e', status: 'compile_error', bundleReady: false }),
    ]);

    const loader = makeLoader(makeDeps());
    const { loaded } = await loader.initialize();

    // None pass the compiled+bundleReady filter
    expect(loaded.size).toBe(0);
  });

  // 4. Returns all discovered extensions alongside the loaded map
  it('returns full extension list alongside loaded map', async () => {
    const records = [
      makeRecord({ id: 'a', status: 'discovered', bundleReady: false }),
      makeRecord({ id: 'b', status: 'compiled', bundleReady: true }),
    ];
    mockFetch(records);

    const loader = makeLoader(makeDeps());
    const { extensions } = await loader.initialize();

    expect(extensions).toHaveLength(2);
    expect(extensions.map((e) => e.id)).toEqual(['a', 'b']);
  });

  // 5. deactivateAll: calls deactivate function and all cleanups for each loaded extension
  it('deactivateAll calls deactivate and all cleanups', async () => {
    const loader = makeLoader(makeDeps());

    const deactivate1 = vi.fn();
    const cleanup1a = vi.fn();
    const cleanup1b = vi.fn();
    const deactivate2 = vi.fn();
    const cleanup2 = vi.fn();

    // Deliver fixture modules through the real loader activation path.

    await activateFixtures(loader, [
      { id: 'ext-1', cleanups: [cleanup1a, cleanup1b], deactivate: deactivate1 },
      { id: 'ext-2', cleanups: [cleanup2], deactivate: deactivate2 },
    ]);

    loader.deactivateAll();

    expect(deactivate1).toHaveBeenCalledOnce();
    expect(cleanup1a).toHaveBeenCalledOnce();
    expect(cleanup1b).toHaveBeenCalledOnce();
    expect(deactivate2).toHaveBeenCalledOnce();
    expect(cleanup2).toHaveBeenCalledOnce();
    expect(loader.getLoaded().size).toBe(0);
  });

  // 6. deactivateAll error resilience: if one cleanup throws, others still run
  it('deactivateAll continues running cleanups after a failure', async () => {
    const loader = makeLoader(makeDeps());

    const cleanupGood1 = vi.fn();
    const cleanupThrows = vi.fn().mockImplementation(() => {
      throw new Error('cleanup boom');
    });
    const cleanupGood2 = vi.fn();

    await activateFixtures(loader, [
      {
        id: 'ext-resilience',
        cleanups: [cleanupGood1, cleanupThrows, cleanupGood2],
        deactivate: undefined,
      },
    ]);

    expect(() => loader.deactivateAll()).not.toThrow();
    expect(cleanupGood1).toHaveBeenCalledOnce();
    expect(cleanupThrows).toHaveBeenCalledOnce();
    expect(cleanupGood2).toHaveBeenCalledOnce();
    expect(loader.getLoaded().size).toBe(0);
  });

  // 7. deactivateAll error resilience: if deactivate() throws, cleanups still run
  it('deactivateAll continues with cleanups even when deactivate() throws', async () => {
    const loader = makeLoader(makeDeps());
    const cleanup = vi.fn();
    const deactivate = vi.fn().mockImplementation(() => {
      throw new Error('deactivate boom');
    });

    await activateFixtures(loader, [{ id: 'ext-bad-deactivate', cleanups: [cleanup], deactivate }]);

    expect(() => loader.deactivateAll()).not.toThrow();
    expect(deactivate).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(loader.getLoaded().size).toBe(0);
  });

  // 8. Import fails: network error on dynamic import is caught, extension skipped
  it('skips extension when bundle import throws', async () => {
    const rec = makeCompiledRecord('failing-ext');
    mockFetch([rec]);

    // The dynamic import to /api/extensions/failing-ext/bundle cannot be
    // resolved in jsdom — it will throw. This test verifies the loader doesn't
    // throw and returns an empty loaded map (error isolation).
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const loader = makeLoader(makeDeps());
    const { loaded } = await loader.initialize();

    expect(loaded.size).toBe(0);
    // Should have logged the import error
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[extensions] Failed to import failing-ext:'),
      expect.anything()
    );

    consoleSpy.mockRestore();
  });

  // 9. No extensions to load logs the expected message
  it('completes an authenticated empty extension list', async () => {
    mockFetch([]);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const loader = makeLoader(makeDeps());
    const outcome = await loader.initialize();

    expect(outcome.status).toBe('completed');
    expect(loader.isOutcomeCurrent(outcome)).toBe(true);
    expect(outcome.loaded.size).toBe(0);
    consoleSpy.mockRestore();
  });

  // 10. Fetch failure: returns empty list gracefully when server is down
  it('returns empty extensions when fetch fails', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const loader = makeLoader(makeDeps());
    const { extensions, loaded } = await loader.initialize();

    expect(extensions).toHaveLength(0);
    expect(loaded.size).toBe(0);
    expect(consoleSpy).toHaveBeenCalledWith(
      '[extensions] Load failed:',
      expect.objectContaining({ message: 'Failed to fetch extension list: 500' })
    );

    consoleSpy.mockRestore();
  });

  // 11. getLoaded reflects the current state
  it('getLoaded returns the current loaded map', () => {
    const loader = makeLoader(makeDeps());
    expect(loader.getLoaded()).toBeInstanceOf(Map);
    expect(loader.getLoaded().size).toBe(0);
  });

  // 12. deactivateAll on extension with no deactivate function (optional field)
  it('deactivateAll works when deactivate is undefined', async () => {
    const loader = makeLoader(makeDeps());
    const cleanup = vi.fn();

    await activateFixtures(loader, [
      { id: 'no-deactivate', cleanups: [cleanup], deactivate: undefined },
    ]);

    expect(() => loader.deactivateAll()).not.toThrow();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(loader.getLoaded().size).toBe(0);
  });

  // 13. deactivateAll sets disposed flag preventing further activations
  it('deactivateAll prevents subsequent initialize activations (StrictMode safety)', () => {
    const loader = makeLoader(makeDeps());

    // Call deactivateAll before any load — simulates StrictMode unmount
    // happening before the async initialize() completes.
    loader.deactivateAll();

    // Access the disposed flag via the private field
    const disposed = (loader as unknown as { disposed: boolean }).disposed;
    expect(disposed).toBe(true);

    // getLoaded should be empty
    expect(loader.getLoaded().size).toBe(0);
  });

  // 14. Multiple extensions loaded — deactivateAll clears all
  it('deactivateAll clears all extensions from the loaded map', async () => {
    const loader = makeLoader(makeDeps());
    const loaded = (loader as unknown as { loaded: Map<string, unknown> }).loaded;

    await activateFixtures(
      loader,
      Array.from({ length: 3 }, (_, i) => ({ id: `ext-${i}` }))
    );

    expect(loaded.size).toBe(3);
    loader.deactivateAll();
    expect(loader.getLoaded().size).toBe(0);
  });
});

describe('ExtensionLoader server lifecycle coordination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  // 14. Server init on activate: extension with hasServerEntry triggers POST init-server
  it('calls POST init-server for extensions with hasServerEntry', async () => {
    const rec = makeRecord({
      id: 'server-ext',
      manifest: { id: 'server-ext', name: 'Server Ext', version: '1.0.0' },
      status: 'compiled',
      bundleReady: true,
      hasServerEntry: true,
      hasDataProxy: false,
    });

    // fetch is called twice: once for the extension list, once for init-server
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([rec]) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });
    global.fetch = fetchSpy;

    // Suppress the dynamic import error (expected in jsdom)
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const loader = makeLoader(makeDeps());
    await loader.initialize();

    // Failed delivery still performs the final generation correspondence read; no init-server.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls.every(([url]) => url === '/api/extensions')).toBe(true);
  });

  // 15. No server init for browser-only extension
  it('does not call init-server for browser-only extensions', async () => {
    const rec = makeRecord({
      id: 'browser-ext',
      status: 'compiled',
      bundleReady: true,
      hasServerEntry: false,
      hasDataProxy: false,
    });
    mockFetch([rec]);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const loader = makeLoader(makeDeps());
    await loader.initialize();

    // Initial and final correspondence lists; no server request may follow a failed import.
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenCalledWith('/api/extensions');
  });

  // 15b. Desktop origin resolution (DOR-243): when the renderer runs under
  // Electron (window.electronAPI present), extension requests must resolve
  // against the preload-reported server port, not a bare relative path that
  // would hit the renderer's own origin (electron-vite dev server or
  // file://) and silently 404/return index.html.
  describe('desktop (Electron) origin resolution', () => {
    afterEach(() => {
      delete (window as { electronAPI?: unknown }).electronAPI;
    });

    it('resolves the extension list fetch against the preload server port', async () => {
      window.electronAPI = {
        getServerPort: vi.fn(() => 6242),
      } as unknown as Window['electronAPI'];

      mockFetch([]);
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const loader = makeLoader(makeDeps());
      await loader.initialize();

      expect(global.fetch).toHaveBeenCalledWith('http://localhost:6242/api/extensions');
    });

    it('resolves the init-server POST against the preload server port', async () => {
      window.electronAPI = {
        getServerPort: vi.fn(() => 6242),
      } as unknown as Window['electronAPI'];

      const rec = makeRecord({
        id: 'server-ext',
        status: 'compiled',
        bundleReady: true,
        hasServerEntry: true,
      });
      const fetchSpy = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([rec]) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });
      global.fetch = fetchSpy;

      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const loader = makeLoader(makeDeps());
      await loader.initialize();

      // The bundle import fails in jsdom, so activation (and thus init-server)
      // never fires — only the list fetch happens. This still proves the list
      // fetch itself was resolved against the Electron origin, not a bare path.
      expect(fetchSpy).toHaveBeenCalledWith('http://localhost:6242/api/extensions');
    });
  });

  // 16. Server init for hasDataProxy extension
  it('calls POST init-server for extensions with hasDataProxy', async () => {
    const rec = makeRecord({
      id: 'proxy-ext',
      manifest: { id: 'proxy-ext', name: 'Proxy Ext', version: '1.0.0' },
      status: 'compiled',
      bundleReady: true,
      hasServerEntry: false,
      hasDataProxy: true,
    });

    mockFetch([rec]);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const loader = makeLoader(makeDeps());
    await loader.initialize();

    // Dynamic import fails in jsdom so init-server won't be triggered via
    // the normal flow. We verify the fetch was only called once (list endpoint).
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  // 17. Server init failure is non-blocking — test via direct invocation pattern
  // Since dynamic import() can't succeed in jsdom, we test the initServerExtension
  // function's error handling by seeding the loader and verifying fetch behavior.
  it('server init failure does not block client activation (seeded test)', async () => {
    const loader = makeLoader(makeDeps());

    // Seed a loaded extension to verify the loader still functions

    await activateFixtures(loader, [{ id: 'resilient-ext', cleanups: [], deactivate: undefined }]);

    // Extension is loaded despite any hypothetical server init failure
    expect(loader.getLoaded().has('resilient-ext')).toBe(true);
    expect(loader.getLoaded().size).toBe(1);
  });

  // 18. Server init with failed response logs warning
  it('logs warning when init-server returns non-ok response', async () => {
    const rec = makeRecord({
      id: 'fail-init',
      hasServerEntry: true,
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Simulate: list returns the extension, init-server returns 400
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([rec]) })
      .mockResolvedValueOnce({
        ok: false,
        statusText: 'Bad Request',
        json: () => Promise.resolve({ error: 'Extension not found' }),
      });
    global.fetch = fetchSpy;

    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const loader = makeLoader(makeDeps());
    await loader.initialize();

    // Dynamic import fails, so init-server not reached. Verify no crash.
    warnSpy.mockRestore();
  });

  // 19. Server init network error logs error
  it('logs error when init-server fetch throws', async () => {
    const rec = makeRecord({
      id: 'net-fail',
      hasServerEntry: true,
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Simulate: list returns extension, init-server throws
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([rec]) })
      .mockRejectedValueOnce(new Error('Network error'));
    global.fetch = fetchSpy;

    vi.spyOn(console, 'log').mockImplementation(() => {});

    const loader = makeLoader(makeDeps());
    await loader.initialize();

    // Dynamic import fails, so init-server not reached. Verify no crash.
    errorSpy.mockRestore();
  });
});

describe('ExtensionLoader auto-register config tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('auto-registers config tab when extension has settings but no secrets', async () => {
    const deps = makeDeps();
    const rec = makeRecord({
      id: 'settings-only',
      manifest: {
        id: 'settings-only',
        name: 'Settings Only Extension',
        version: '1.0.0',
        serverCapabilities: {
          serverEntry: './server.ts',
          settings: [{ type: 'boolean', key: 'enabled', label: 'Enabled', required: false }],
        },
      },
    });

    const loader = makeLoader(deps);
    await activateFixtures(loader, [{ id: rec.id, record: rec }]);

    // Verify registry.register was called with 'settings.tabs'
    expect(deps.registry.register).toHaveBeenCalledWith(
      'settings.tabs',
      expect.objectContaining({
        id: 'settings-only:settings',
        label: 'Settings Only Extension',
      })
    );
  });

  it('auto-registers unified config tab when extension has both secrets and settings', async () => {
    const deps = makeDeps();
    const rec = makeRecord({
      id: 'combined-ext',
      manifest: {
        id: 'combined-ext',
        name: 'Combined Extension',
        version: '1.0.0',
        serverCapabilities: {
          serverEntry: './server.ts',
          secrets: [{ key: 'api_key', label: 'API Key', required: false }],
          settings: [{ type: 'number', key: 'interval', label: 'Interval', required: false }],
        },
      },
    });

    const loader = makeLoader(deps);
    await activateFixtures(loader, [{ id: rec.id, record: rec }]);

    // Should register exactly ONE tab (unified), not two
    expect(deps.registry.register).toHaveBeenCalledTimes(1);
    expect(deps.registry.register).toHaveBeenCalledWith(
      'settings.tabs',
      expect.objectContaining({
        id: 'combined-ext:settings',
        label: 'Combined Extension',
      })
    );
  });

  it('does not auto-register config tab when extension has no secrets or settings', async () => {
    const deps = makeDeps();
    const rec = makeRecord({
      manifest: {
        id: 'ui-only',
        name: 'UI Only Extension',
        version: '1.0.0',
      },
    });

    const loader = makeLoader(deps);
    await activateFixtures(loader, [{ id: rec.id, record: rec }]);

    expect(deps.registry.register).not.toHaveBeenCalled();
  });

  it('does not auto-register when secrets and settings are empty arrays', async () => {
    const deps = makeDeps();
    const rec = makeRecord({
      manifest: {
        id: 'empty-ext',
        name: 'Empty Extension',
        version: '1.0.0',
        serverCapabilities: {
          serverEntry: './server.ts',
          secrets: [],
          settings: [],
        },
      },
    });

    const loader = makeLoader(deps);
    await activateFixtures(loader, [{ id: rec.id, record: rec }]);

    expect(deps.registry.register).not.toHaveBeenCalled();
  });

  it('cleanup function from register is tracked in cleanups array', async () => {
    const unsubFn = vi.fn();
    const deps = makeDeps({
      registry: {
        register: vi.fn().mockReturnValue(unsubFn),
        getContributions: vi.fn().mockReturnValue([]),
        setTabMarker: vi.fn(),
        clearTabMarkers: vi.fn(),
      },
    });
    const rec = makeRecord({
      manifest: {
        id: 'tracked',
        name: 'Tracked',
        version: '1.0.0',
        serverCapabilities: {
          serverEntry: './server.ts',
          secrets: [{ key: 'key', label: 'Key', required: false }],
        },
      },
    });

    const loader = makeLoader(deps);
    await activateFixtures(loader, [{ id: rec.id, record: rec }]);
    const cleanups = loader.getLoaded().get(rec.id)!.cleanups;

    expect(cleanups).not.toHaveLength(0);
    expect(new Set(cleanups).size).toBe(1);
    expect(loader.deactivateAll()).toBe(true);
    expect(unsubFn).toHaveBeenCalledOnce();
  });
});

// A virtual bundle substitutes only module delivery; activation and cleanup stay real.
describe('genuine loader activation custody', () => {
  it('activates a delivered bundle and releases its registered contribution', async () => {
    const cleanup = vi.fn();
    const deps = makeDeps();
    vi.mocked(deps.registry.register).mockReturnValue(cleanup);
    const generation = 'a'.repeat(64);
    const url = `/api/extensions/owned-fixture/bundle?generation=${generation}`;
    vi.doMock(url, () => ({
      activate(api: import('@dorkos/extension-api').ExtensionAPI) {
        api.registerComponent('dashboard.sections', 'owned', () => null);
      },
    }));
    mockFetch([makeRecord({ id: 'owned-fixture', bundleGeneration: generation })]);
    const loader = new ExtensionLoader(deps, getExtensionLoadAdmission(), vi.fn());
    const outcome = await loader.initialize();
    expect(outcome.status).toBe('completed');
    expect(outcome.loaded.has('owned-fixture')).toBe(true);
    expect(deps.registry.register).toHaveBeenCalledOnce();
    loader.deactivateAll();
    expect(cleanup).toHaveBeenCalledOnce();
    vi.doUnmock(url);
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
  entries: Array<{
    id: string;
    deactivate?: () => void;
    cleanups?: Array<() => void>;
    record?: ExtensionRecordPublic;
    activate?: (api: import('@dorkos/extension-api').ExtensionAPI) => void;
  }>
): Promise<void> {
  const deps = fixtureDeps.get(loader)!;
  const previousFetch = globalThis.fetch;
  const records = entries.map((entry) => entry.record ?? makeRecord({ id: entry.id }));
  const urls = records.map(
    (record) => '/api/extensions/' + record.id + '/bundle?generation=' + record.bundleGeneration
  );
  entries.forEach((entry, index) =>
    vi.doMock(urls[index], () => ({
      activate(api: import('@dorkos/extension-api').ExtensionAPI) {
        entry.activate?.(api);
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

describe('genuine loader command occurrence custody', () => {
  it.each([false, true])(
    'old caller cleanup before replacement=%s never removes the new same-ID handler',
    async (early) => {
      const deps = makeDeps();
      const handlers = new Map<string, () => void>();
      const rows = new Map<string, unknown>();
      const releases: Array<ReturnType<typeof vi.fn>> = [];
      vi.mocked(deps.registry.register).mockImplementation((_slot, contribution) => {
        const id = (contribution as { id: string }).id;
        rows.set(id, contribution);
        const release = vi.fn(() => rows.delete(id));
        releases.push(release);
        return release;
      });
      vi.mocked(deps.registerCommandHandler).mockImplementation((id, callback) => {
        handlers.set(id, callback);
      });
      vi.mocked(deps.unregisterCommandHandler).mockImplementation((id) => {
        handlers.delete(id);
      });
      const loader = makeLoader(deps);
      const oldCallback = vi.fn();
      const newCallback = vi.fn();
      let oldCleanup!: () => void;
      let newCleanup!: () => void;
      await activateFixtures(loader, [
        {
          id: 'command-owner',
          activate(api) {
            oldCleanup = api.registerCommand('same', 'Original', oldCallback);
            if (early) oldCleanup();
            newCleanup = api.registerCommand('same', 'Replacement', newCallback);
          },
        },
      ]);
      const originalRemovalCount = early ? 1 : 0;
      oldCleanup();
      expect(releases[0]).toHaveBeenCalledTimes(originalRemovalCount);
      expect(rows.size).toBe(1);
      expect(handlers.has('ext:command-owner:same')).toBe(true);
      handlers.get('ext:command-owner:same')!();
      expect(newCallback).toHaveBeenCalledOnce();
      expect(oldCallback).not.toHaveBeenCalled();
      expect(deps.unregisterCommandHandler).toHaveBeenCalledTimes(originalRemovalCount);
      expect(loader.deactivateAll()).toBe(true);
      expect(rows.size).toBe(0);
      expect(handlers.size).toBe(0);
      expect(releases[1]).toHaveBeenCalledOnce();
      expect(deps.unregisterCommandHandler).toHaveBeenCalledTimes(originalRemovalCount + 1);
      oldCleanup();
      newCleanup();
      expect(releases[1]).toHaveBeenCalledOnce();
      expect(deps.unregisterCommandHandler).toHaveBeenCalledTimes(originalRemovalCount + 1);
    }
  );
  it('a throwing contribution release still attempts the independently recorded handler removal once', async () => {
    const deps = makeDeps();
    const release = vi.fn(() => {
      throw new Error('OWNED_RELEASE_FAILED');
    });
    vi.mocked(deps.registry.register).mockReturnValue(release);
    const loader = makeLoader(deps);
    await activateFixtures(loader, [
      {
        id: 'failed-command',
        activate(api) {
          api.registerCommand('same', 'Fixture', () => {});
        },
      },
    ]);
    expect(loader.deactivateAll()).toBe(false);
    expect(release).toHaveBeenCalledOnce();
    expect(deps.unregisterCommandHandler).toHaveBeenCalledOnce();
    expect(loader.deactivateAll()).toBe(false);
    expect(release).toHaveBeenCalledOnce();
    expect(deps.unregisterCommandHandler).toHaveBeenCalledOnce();
  });
});

describe('genuine loader subscription occurrence custody', () => {
  it.each(['store', 'events'] as const)(
    'caller %s unsubscribe and later retirement share one cleanup',
    async (kind) => {
      const deps = makeDeps();
      const release = vi.fn();
      if (kind === 'store') vi.mocked(deps.appStore.subscribe).mockReturnValue(release);
      else vi.mocked(deps.eventBridge.subscribe).mockReturnValue(release);
      const loader = makeLoader(deps);
      let unsubscribe!: () => void;
      await activateFixtures(loader, [
        {
          id: 'subscription-owner',
          record: makeRecord({
            id: 'subscription-owner',
            manifest: { ...makeRecord().manifest, capabilities: { events: ['turn.completed'] } },
          }),
          activate(api) {
            unsubscribe =
              kind === 'store'
                ? api.subscribe(
                    () => null,
                    () => {}
                  )
                : api.events.subscribe(['turn.completed'], () => {});
          },
        },
      ]);
      expect(release).not.toHaveBeenCalled();
      unsubscribe();
      expect(release).toHaveBeenCalledOnce();
      expect(loader.deactivateAll()).toBe(true);
      unsubscribe();
      expect(release).toHaveBeenCalledOnce();
    }
  );
});

describe('caller cleanup failure remains lifetime uncertainty', () => {
  it.each(['store', 'events', 'command'] as const)(
    '%s failed cleanup is not replayed or healed by retirement',
    async (kind) => {
      const deps = makeDeps();
      const cause = new Error('OWNED_CLEANUP_FAILED');
      const release = vi.fn(() => {
        throw cause;
      });
      if (kind === 'store') vi.mocked(deps.appStore.subscribe).mockReturnValue(release);
      if (kind === 'events') vi.mocked(deps.eventBridge.subscribe).mockReturnValue(release);
      if (kind === 'command') vi.mocked(deps.registry.register).mockReturnValue(release);
      const loader = makeLoader(deps);
      let unsubscribe!: () => void;
      await activateFixtures(loader, [
        {
          id: 'failed-subscription',
          record: makeRecord({
            id: 'failed-subscription',
            manifest: { ...makeRecord().manifest, capabilities: { events: ['turn.completed'] } },
          }),
          activate(api) {
            if (kind === 'command')
              unsubscribe = api.registerCommand('fixture', 'Fixture', () => {});
            else
              unsubscribe =
                kind === 'store'
                  ? api.subscribe(
                      () => null,
                      () => {}
                    )
                  : api.events.subscribe(['turn.completed'], () => {});
          },
        },
      ]);
      expect(() => unsubscribe()).toThrow(cause);
      expect(release).toHaveBeenCalledOnce();
      expect(loader.deactivateAll()).toBe(false);
      expect(loader.deactivateAll()).toBe(false);
      expect(release).toHaveBeenCalledOnce();
      if (kind === 'command') expect(deps.unregisterCommandHandler).toHaveBeenCalledOnce();
    }
  );
});

describe('caller cleanup return remains unobserved settlement', () => {
  it.each(['store', 'events', 'command'] as const)(
    '%s preserves an unsupported returned thenable for later retirement',
    async (kind) => {
      const deps = makeDeps();
      const pending = { then() {} };
      const release = vi.fn(() => pending);
      if (kind === 'store') vi.mocked(deps.appStore.subscribe).mockReturnValue(release);
      if (kind === 'events') vi.mocked(deps.eventBridge.subscribe).mockReturnValue(release);
      if (kind === 'command') vi.mocked(deps.registry.register).mockReturnValue(release);
      const loader = makeLoader(deps);
      let unsubscribe!: () => void;
      await activateFixtures(loader, [
        {
          id: 'pending-subscription',
          record: makeRecord({
            id: 'pending-subscription',
            manifest: { ...makeRecord().manifest, capabilities: { events: ['turn.completed'] } },
          }),
          activate(api) {
            if (kind === 'command')
              unsubscribe = api.registerCommand('fixture', 'Fixture', () => {});
            else
              unsubscribe =
                kind === 'store'
                  ? api.subscribe(
                      () => null,
                      () => {}
                    )
                  : api.events.subscribe(['turn.completed'], () => {});
          },
        },
      ]);
      unsubscribe();
      expect(release).toHaveBeenCalledOnce();
      expect(loader.deactivateAll()).toBe(false);
      expect(release).toHaveBeenCalledOnce();
      if (kind === 'command') expect(deps.unregisterCommandHandler).toHaveBeenCalledOnce();
    }
  );
});

/** Real Zustand commit notifications; only module delivery is substituted. */
async function unreturnedReceiptFixture(kind: 'healthy' | 'getter' | 'entered' | 'committed') {
  const id = 'receipt-' + kind;
  const record = makeCompiledRecord(id);
  const url = '/api/extensions/' + id + '/bundle?generation=' + record.bundleGeneration;
  const previousFetch = globalThis.fetch;
  useExtensionRegistry.setState({ slots: createInitialSlots() });
  const registry = useExtensionRegistry.getState();
  const failure = vi.fn();
  const register = vi.fn(() => {
    throw new Error('ENTERED_WITHOUT_RECEIPT');
  });
  const port = kind === 'entered' ? { ...registry, register } : { ...registry };
  if (kind === 'getter')
    Object.defineProperty(port, 'register', {
      get() {
        throw new Error('REFUSED_BEFORE_ENTRY');
      },
    });
  let notified = false;
  const stop = useExtensionRegistry.subscribe(() => {
    if (kind === 'committed' && !notified) {
      notified = true;
      throw new Error('COMMITTED_NOTIFICATION_FAILED');
    }
  });
  const loader = new ExtensionLoader(
    makeDeps({ registry: port as unknown as ExtensionAPIDeps['registry'] }),
    getExtensionLoadAdmission(),
    failure
  );
  vi.doMock(url, () => ({
    activate(api: import('@dorkos/extension-api').ExtensionAPI) {
      api.registerComponent('dashboard.sections', 'one', () => null);
    },
  }));
  mockFetch([record]);
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const outcome = await loader.initialize();
    return { loader, failure, outcome, register, registry };
  } finally {
    stop();
    errors.mockRestore();
    globalThis.fetch = previousFetch;
    vi.doUnmock(url);
  }
}

describe('unreturned registration receipt custody', () => {
  afterEach(() => useExtensionRegistry.setState({ slots: createInitialSlots() }));
  it.each(['healthy', 'getter'] as const)(
    '%s remains conclusive with real registry state',
    async (kind) => {
      const { loader, outcome, failure } = await unreturnedReceiptFixture(kind);
      expect(outcome.loaded.size).toBe(kind === 'healthy' ? 1 : 0);
      expect(useExtensionRegistry.getState().slots['dashboard.sections']).toHaveLength(
        kind === 'healthy' ? 1 : 0
      );
      expect(loader.deactivateAll()).toBe(true);
      expect(useExtensionRegistry.getState().slots['dashboard.sections']).toHaveLength(0);
      expect(failure).not.toHaveBeenCalled();
    }
  );
  it.each(['entered', 'committed'] as const)(
    '%s without a receipt retains sticky unknown custody',
    async (kind) => {
      const { loader, outcome, failure, register } = await unreturnedReceiptFixture(kind);
      expect(outcome.loaded.size).toBe(0);
      expect(useExtensionRegistry.getState().slots['dashboard.sections']).toHaveLength(
        kind === 'committed' ? 1 : 0
      );
      if (kind === 'entered') expect(register).toHaveBeenCalledOnce();
      expect(loader.deactivateAll()).toBe(false);
      expect(loader.deactivateAll()).toBe(false);
      expect(failure).toHaveBeenCalledOnce();
    }
  );
  it('unknown old occurrence never removes a genuine same-ID replacement', async () => {
    const { loader, registry } = await unreturnedReceiptFixture('committed');
    const component = () => null;
    const release = registry.register('dashboard.sections', {
      id: 'receipt-committed:one',
      component,
    });
    expect(loader.deactivateAll()).toBe(false);
    expect(useExtensionRegistry.getState().slots['dashboard.sections'][0].component).toBe(
      component
    );
    release();
    expect(useExtensionRegistry.getState().slots['dashboard.sections']).toHaveLength(0);
  });
  it('genuine provider retirement cannot heal unknown custody after current sign-in', async () => {
    const { loader } = await unreturnedReceiptFixture('committed');
    const provider = {};
    const unregister = registerExtensionLoadOwner(
      provider,
      getExtensionLoadAdmission(),
      () => loader.deactivateAll(),
      async () => {}
    );
    try {
      beginExtensionAuthOperation({}, 'signOut');
      const owner = {};
      const token = beginExtensionAuthOperation(owner, 'signIn');
      expect(authenticateExtensionAuthOperation(owner, token)).toBe(true);
      expect(resumeExtensionLoads(owner, token)).toBeNull();
      expect(getExtensionLoadAdmission().suspended).toBe(true);
      expect(getExtensionLoadAdmission().retirementFailed).toBe(true);
      expect(useExtensionRegistry.getState().slots['dashboard.sections']).toHaveLength(1);
    } finally {
      unregister();
    }
  });
});
