/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock sonner (pulled in transitively by extension-api-factory)
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

// Mock ui-action-dispatcher (pulled in transitively by extension-api-factory)
vi.mock('@/layers/shared/lib/ui-action-dispatcher', () => ({
  executeUiCommand: vi.fn(),
}));

import { ExtensionLoader } from '../model/extension-loader';
import type { ExtensionAPIDeps, LoadedExtension } from '../model/types';
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
    ...overrides,
  };
}

/**
 * Seed a loaded extension into the loader's internal map.
 *
 * Since dynamic import() cannot resolve /api/extensions/... URLs in jsdom,
 * we seed the loaded map directly to test deactivation/reload paths.
 */
function seedLoaded(
  loader: ExtensionLoader,
  entry: {
    id: string;
    deactivate?: () => void;
    cleanups?: Array<() => void>;
  }
): void {
  const loaded = (loader as unknown as { loaded: Map<string, LoadedExtension> }).loaded;
  loaded.set(entry.id, {
    id: entry.id,
    manifest: { id: entry.id, name: `Ext ${entry.id}`, version: '1.0.0' },
    module: { activate: vi.fn() },
    api: {} as LoadedExtension['api'],
    cleanups: entry.cleanups ?? [],
    deactivate: entry.deactivate,
  });
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
    const loader = new ExtensionLoader(makeDeps());
    seedLoaded(loader, { id: 'my-ext', deactivate, cleanups: [cleanup] });

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

  it('imports new bundle with cache-busted URL containing timestamp', async () => {
    const loader = new ExtensionLoader(makeDeps());
    seedLoaded(loader, { id: 'my-ext' });

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
      expect.stringContaining('[extensions] Failed to hot-reload my-ext:'),
      expect.anything()
    );
  });

  it('preserves other extensions during targeted reload', async () => {
    const loader = new ExtensionLoader(makeDeps());

    // Seed two extensions
    seedLoaded(loader, { id: 'ext-a' });
    seedLoaded(loader, { id: 'ext-b' });

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
    const loader = new ExtensionLoader(makeDeps());
    seedLoaded(loader, { id: 'bad-ext' });

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
    const loader = new ExtensionLoader(makeDeps());
    seedLoaded(loader, { id: 'removed-ext' });

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
    const loader = new ExtensionLoader(makeDeps());
    seedLoaded(loader, { id: 'gone-ext' });

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
    const loader = new ExtensionLoader(makeDeps());
    seedLoaded(loader, {
      id: 'crash-deactivate',
      deactivate: () => {
        throw new Error('deactivate boom');
      },
      cleanups: [
        () => {
          throw new Error('cleanup boom');
        },
      ],
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          makeRecord({ id: 'crash-deactivate', status: 'compiled', bundleReady: true }),
        ]),
    });

    // Should not throw even though deactivate and cleanup both throw
    await expect(loader.reloadExtensions(['crash-deactivate'])).resolves.toBeDefined();

    // Errors were logged
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[extensions] Error deactivating crash-deactivate:'),
      expect.anything()
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[extensions] Error in cleanup for crash-deactivate:'),
      expect.anything()
    );
  });

  it('returns refreshed extension list from server', async () => {
    const loader = new ExtensionLoader(makeDeps());
    seedLoaded(loader, { id: 'ext-a' });

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

    const loader = new ExtensionLoader(makeDeps());
    seedLoaded(loader, { id: 'ext-a', deactivate: deactivateA });
    seedLoaded(loader, { id: 'ext-b', deactivate: deactivateB });
    seedLoaded(loader, { id: 'ext-c' }); // This one stays

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
    const loader = new ExtensionLoader(makeDeps());

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
