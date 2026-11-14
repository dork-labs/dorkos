/**
 * @vitest-environment jsdom
 */
/**
 * An extension whose `activate()` throws part-way leaves nothing behind: what it
 * registered before the throw is removed, on first load and on hot reload.
 * Bundles only ever run inside an app's frame, so the loader is handed a module
 * whose `activate()` behaves like one that registered a command and then threw.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/layers/shared/lib/ui-action-dispatcher', () => ({
  executeUiCommand: vi.fn(),
}));

/** A module that registers a command and then throws. */
vi.mock('../model/extension-bundle-import', () => ({
  importExtensionModule: vi.fn(async () => ({
    activate(api: { registerCommand(id: string, label: string, run: () => void): void }) {
      api.registerCommand('go', 'Go', () => {});
      throw new Error('boom');
    },
  })),
}));

import { ExtensionLoader } from '../model/extension-loader';
import type { ExtensionAPIDeps } from '../model/types';

function makeDeps(unsubscribe: () => void): ExtensionAPIDeps {
  return {
    registry: {
      register: vi.fn().mockReturnValue(unsubscribe),
      getContributions: vi.fn().mockReturnValue([]),
      setTabMarker: vi.fn(),
      clearTabMarkers: vi.fn(),
      setPageBadge: vi.fn(),
      clearPageBadges: vi.fn(),
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
      'command-palette.items',
    ] as const) as ExtensionAPIDeps['availableSlots'],
    registerCommandHandler: vi.fn(),
    unregisterCommandHandler: vi.fn(),
    eventBridge: { subscribe: vi.fn().mockReturnValue(vi.fn()) },
  };
}

const record: ExtensionRecordPublic = {
  id: 'thrower',
  manifest: { clientApiVersion: 2, id: 'thrower', name: 'Thrower', version: '1.0.0' },
  status: 'compiled',
  scope: 'global',
  origin: 'user',
  bundleReady: true,
  hasServerEntry: false,
  hasDataProxy: false,
  approvedToRun: true,
  shadowedBy: null,
};

beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([record]) });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExtensionLoader when activate() throws', () => {
  it('removes what the extension registered before throwing, on first load', async () => {
    const unsubscribe = vi.fn();
    const deps = makeDeps(unsubscribe);

    const { loaded } = await new ExtensionLoader(deps).initialize();

    expect(deps.registry.register).toHaveBeenCalledWith(
      'command-palette.items',
      expect.objectContaining({ id: 'thrower:go' })
    );
    expect(loaded.has('thrower')).toBe(false);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(deps.unregisterCommandHandler).toHaveBeenCalledWith('ext:thrower:go');
  });

  it('removes what the extension registered before throwing, on hot reload', async () => {
    const unsubscribe = vi.fn();
    const deps = makeDeps(unsubscribe);

    const { loaded } = await new ExtensionLoader(deps).reloadExtensions(['thrower']);

    expect(deps.registry.register).toHaveBeenCalledWith(
      'settings.tabs',
      expect.objectContaining({ id: 'thrower:load-error' })
    );
    expect(loaded.has('thrower')).toBe(false);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
