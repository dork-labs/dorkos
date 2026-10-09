/**
 * @vitest-environment jsdom
 */
/**
 * An extension whose `activate()` throws part-way leaves nothing behind: what it
 * registered before the throw is removed, on first load and on hot reload.
 * The bundle URL is pointed at a `data:` module so the real dynamic import runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/layers/shared/lib/ui-action-dispatcher', () => ({
  executeUiCommand: vi.fn(),
}));

/** A bundle that registers a command and then throws. */
const THROWING_BUNDLE =
  'data:text/javascript,' +
  encodeURIComponent(
    "export function activate(api) { api.registerCommand('go', 'Go', () => {}); throw new Error('boom'); }"
  );

vi.mock('../model/extension-api-url', () => ({
  extensionApiUrl: (path: string) => (path.includes('/bundle') ? THROWING_BUNDLE : path),
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
  manifest: { id: 'thrower', name: 'Thrower', version: '1.0.0' },
  status: 'compiled',
  scope: 'global',
  origin: 'user',
  bundleReady: true,
  bundleGeneration: 'a'.repeat(64),
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

    expect(deps.registry.register).toHaveBeenCalledTimes(1);
    expect(loaded.has('thrower')).toBe(false);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
