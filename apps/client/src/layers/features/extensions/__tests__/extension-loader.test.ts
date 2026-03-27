/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock sonner (pulled in transitively by extension-api-factory)
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

// Mock ui-action-dispatcher (pulled in transitively by extension-api-factory)
vi.mock('@/layers/shared/lib/ui-action-dispatcher', () => ({
  executeUiCommand: vi.fn(),
}));

import { ExtensionLoader } from '../model/extension-loader';
import type { ExtensionAPIDeps } from '../model/types';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';

// --- Helpers ---

function makeDeps(overrides: Partial<ExtensionAPIDeps> = {}): ExtensionAPIDeps {
  return {
    registry: { register: vi.fn().mockReturnValue(vi.fn()) },
    dispatcherContext: {
      store: {} as ExtensionAPIDeps['dispatcherContext']['store'],
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
    ...overrides,
  };
}

function makeRecord(overrides: Partial<ExtensionRecordPublic> = {}): ExtensionRecordPublic {
  return {
    id: 'test-ext',
    manifest: { id: 'test-ext', name: 'Test Extension', version: '1.0.0' },
    status: 'compiled',
    scope: 'global',
    bundleReady: true,
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

    const loader = new ExtensionLoader(makeDeps());
    const { loaded, extensions } = await loader.initialize();

    expect(loaded.size).toBe(0);
    // Full list still returned for callers that need all records
    expect(extensions).toHaveLength(2);
  });

  // 2. Load and activate: successfully activates a pre-seeded extension via getLoaded
  // Note: dynamic import() of /api/extensions/…/bundle cannot be resolved in jsdom
  // (the URL is not in Vite's module graph). The activation path is therefore tested
  // through the public surface: seeding the loaded map directly (as the loader would
  // do after a successful import) and asserting getLoaded() reflects the state.
  // The error-isolation path (import throws → extension skipped) is tested in #8.
  it('getLoaded reflects extensions seeded after successful activation', () => {
    const loader = new ExtensionLoader(makeDeps());

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

    const loader = new ExtensionLoader(makeDeps());
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

    const loader = new ExtensionLoader(makeDeps());
    const { extensions } = await loader.initialize();

    expect(extensions).toHaveLength(2);
    expect(extensions.map((e) => e.id)).toEqual(['a', 'b']);
  });

  // 5. deactivateAll: calls deactivate function and all cleanups for each loaded extension
  it('deactivateAll calls deactivate and all cleanups', () => {
    const loader = new ExtensionLoader(makeDeps());

    const deactivate1 = vi.fn();
    const cleanup1a = vi.fn();
    const cleanup1b = vi.fn();
    const deactivate2 = vi.fn();
    const cleanup2 = vi.fn();

    // Directly seed the loaded map to test deactivation independently from
    // the dynamic-import path (which cannot resolve /api/extensions/…/bundle
    // in the jsdom environment).
    const loaded = (loader as unknown as { loaded: Map<string, unknown> }).loaded;
    loaded.set('ext-1', {
      id: 'ext-1',
      manifest: { name: 'Ext 1', version: '1.0.0', entry: 'index.js' },
      module: {},
      api: {},
      cleanups: [cleanup1a, cleanup1b],
      deactivate: deactivate1,
    });
    loaded.set('ext-2', {
      id: 'ext-2',
      manifest: { name: 'Ext 2', version: '1.0.0', entry: 'index.js' },
      module: {},
      api: {},
      cleanups: [cleanup2],
      deactivate: deactivate2,
    });

    loader.deactivateAll();

    expect(deactivate1).toHaveBeenCalledOnce();
    expect(cleanup1a).toHaveBeenCalledOnce();
    expect(cleanup1b).toHaveBeenCalledOnce();
    expect(deactivate2).toHaveBeenCalledOnce();
    expect(cleanup2).toHaveBeenCalledOnce();
    expect(loader.getLoaded().size).toBe(0);
  });

  // 6. deactivateAll error resilience: if one cleanup throws, others still run
  it('deactivateAll continues running cleanups after a failure', () => {
    const loader = new ExtensionLoader(makeDeps());

    const cleanupGood1 = vi.fn();
    const cleanupThrows = vi.fn().mockImplementation(() => {
      throw new Error('cleanup boom');
    });
    const cleanupGood2 = vi.fn();

    const loaded = (loader as unknown as { loaded: Map<string, unknown> }).loaded;
    loaded.set('ext-resilience', {
      id: 'ext-resilience',
      manifest: { name: 'Resilience', version: '1.0.0', entry: 'index.js' },
      module: {},
      api: {},
      cleanups: [cleanupGood1, cleanupThrows, cleanupGood2],
      deactivate: undefined,
    });

    expect(() => loader.deactivateAll()).not.toThrow();
    expect(cleanupGood1).toHaveBeenCalledOnce();
    expect(cleanupThrows).toHaveBeenCalledOnce();
    expect(cleanupGood2).toHaveBeenCalledOnce();
    expect(loader.getLoaded().size).toBe(0);
  });

  // 7. deactivateAll error resilience: if deactivate() throws, cleanups still run
  it('deactivateAll continues with cleanups even when deactivate() throws', () => {
    const loader = new ExtensionLoader(makeDeps());
    const cleanup = vi.fn();
    const deactivate = vi.fn().mockImplementation(() => {
      throw new Error('deactivate boom');
    });

    const loaded = (loader as unknown as { loaded: Map<string, unknown> }).loaded;
    loaded.set('ext-bad-deactivate', {
      id: 'ext-bad-deactivate',
      manifest: { name: 'Bad Deactivate', version: '1.0.0', entry: 'index.js' },
      module: {},
      api: {},
      cleanups: [cleanup],
      deactivate,
    });

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

    const loader = new ExtensionLoader(makeDeps());
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
  it('logs when no extensions are ready to load', async () => {
    mockFetch([]);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const loader = new ExtensionLoader(makeDeps());
    await loader.initialize();

    expect(consoleSpy).toHaveBeenCalledWith('[extensions] No extensions to load');
    consoleSpy.mockRestore();
  });

  // 10. Fetch failure: returns empty list gracefully when server is down
  it('returns empty extensions when fetch fails', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const loader = new ExtensionLoader(makeDeps());
    const { extensions, loaded } = await loader.initialize();

    expect(extensions).toHaveLength(0);
    expect(loaded.size).toBe(0);
    expect(consoleSpy).toHaveBeenCalledWith('[extensions] Failed to fetch extension list:', 500);

    consoleSpy.mockRestore();
  });

  // 11. getLoaded reflects the current state
  it('getLoaded returns the current loaded map', () => {
    const loader = new ExtensionLoader(makeDeps());
    expect(loader.getLoaded()).toBeInstanceOf(Map);
    expect(loader.getLoaded().size).toBe(0);
  });

  // 12. deactivateAll on extension with no deactivate function (optional field)
  it('deactivateAll works when deactivate is undefined', () => {
    const loader = new ExtensionLoader(makeDeps());
    const cleanup = vi.fn();

    const loaded = (loader as unknown as { loaded: Map<string, unknown> }).loaded;
    loaded.set('no-deactivate', {
      id: 'no-deactivate',
      manifest: { name: 'No Deactivate', version: '0.1.0', entry: 'index.js' },
      module: {},
      api: {},
      cleanups: [cleanup],
      deactivate: undefined,
    });

    expect(() => loader.deactivateAll()).not.toThrow();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(loader.getLoaded().size).toBe(0);
  });

  // 13. Multiple extensions loaded — deactivateAll clears all
  it('deactivateAll clears all extensions from the loaded map', () => {
    const loader = new ExtensionLoader(makeDeps());
    const loaded = (loader as unknown as { loaded: Map<string, unknown> }).loaded;

    for (let i = 0; i < 3; i++) {
      loaded.set(`ext-${i}`, {
        id: `ext-${i}`,
        manifest: { name: `Ext ${i}`, version: '1.0.0', entry: 'index.js' },
        module: {},
        api: {},
        cleanups: [],
        deactivate: undefined,
      });
    }

    expect(loaded.size).toBe(3);
    loader.deactivateAll();
    expect(loader.getLoaded().size).toBe(0);
  });
});
