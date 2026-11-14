/** @vitest-environment jsdom */
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionRecordPublic, ExtensionModule, ExtensionAPI } from '@dorkos/extension-api';
import { buildAppCatalog } from '@/layers/entities/extension/lib/app-catalog';
import { useExtensionRegistry } from '@/layers/shared/model/extension-registry';
import {
  getExtensionClientStates,
  setExtensionClientState,
} from '@/layers/shared/lib/extension-client-state';
import { getExtensionNames, setExtensionNames } from '@/layers/shared/lib/extension-names';
import { importExtensionModule } from '../model/extension-bundle-import';
import { runningAppManifest, setRunningApps } from '../frame/running-apps';
import { ExtensionLoader, EXTENSION_IMPORT_TIMEOUT_MS } from '../model/extension-loader';
import type { ExtensionAPIDeps } from '../model/types';

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));
vi.mock('@/layers/shared/lib/ui-action-dispatcher', () => ({ executeUiCommand: vi.fn() }));
vi.mock('../model/extension-bundle-import', () => ({ importExtensionModule: vi.fn() }));

function moduleFor(name = 'Garden'): ExtensionModule {
  return {
    activate(api: ExtensionAPI) {
      api.registerPage('', () => null, { title: name });
      api.registerSettingsTab('settings', name + ' settings', () => null);
    },
  };
}

function deps(): ExtensionAPIDeps {
  return {
    registry: useExtensionRegistry.getState() as unknown as ExtensionAPIDeps['registry'],
    dispatcherContext: {
      getStore: () => ({}) as ReturnType<ExtensionAPIDeps['dispatcherContext']['getStore']>,
      setTheme: vi.fn(),
    },
    navigate: vi.fn(),
    appStore: { getState: vi.fn(() => ({})), subscribe: vi.fn(() => vi.fn()) },
    availableSlots: new Set(['settings.tabs']) as ExtensionAPIDeps['availableSlots'],
    registerCommandHandler: vi.fn(),
    unregisterCommandHandler: vi.fn(),
    eventBridge: { subscribe: vi.fn(() => vi.fn()) },
  };
}

let loader: ExtensionLoader;
beforeEach(() => {
  vi.mocked(importExtensionModule).mockReset().mockResolvedValue(moduleFor());
  vi.spyOn(console, 'error').mockImplementation(() => {});
  loader = new ExtensionLoader(deps());
});
afterEach(() => {
  cleanup();
  loader.deactivateAll();
  for (const id of Object.keys(getExtensionClientStates())) setExtensionClientState(id, undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** An app placed directly in an extension folder, without a marketplace record. */
function record(id: string, scope: 'global' | 'local' = 'global'): ExtensionRecordPublic {
  return {
    id,
    manifest: { clientApiVersion: 2, id, name: id, version: '1.0.0' },
    status: 'compiled',
    scope,
    origin: 'user',
    bundleReady: true,
    approvedToRun: true,
    hasServerEntry: false,
    hasDataProxy: false,
    shadowedBy: null,
  };
}

function catalog(records: ExtensionRecordPublic[]) {
  return buildAppCatalog({
    extensions: records,
    failed: false,
    waitingIds: new Set(),
    pages: useExtensionRegistry.getState().slots.pages,
    badges: {},
    known: {},
    pins: [],
    clientStates: getExtensionClientStates(),
  });
}

describe('apps built for the old extension API', () => {
  function oldApp(id: string, rightPanel = false): ExtensionRecordPublic {
    const old = record(id);
    delete (old.manifest as { clientApiVersion?: 2 }).clientApiVersion;
    if (rightPanel) old.manifest.contributions = { 'right-panel': true };
    return old;
  }

  it('never fetches their code, and leaves no error tab or frame behind', async () => {
    const old = oldApp('meadow');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => [old] }))
    );
    await loader.initialize();
    expect(importExtensionModule).not.toHaveBeenCalled();
    expect(loader.getLoaded().has('meadow')).toBe(false);
    expect(getExtensionClientStates().meadow).toBeUndefined();
    const ids = useExtensionRegistry.getState().slots['settings.tabs'].map((tab) => tab.id);
    expect(ids).not.toContain('meadow:load-error');
    // The catalog reads the record: its tile says it needs an update.
    expect(catalog([old]).apps.map((app) => [app.id, app.state])).toEqual([
      ['meadow', 'needs-update'],
    ]);
  });

  it('keeps a declared right-panel tab that says, in the same words, it needs an update', async () => {
    const old = oldApp('meadow', true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => [old] }))
    );
    await loader.initialize();
    const tab = useExtensionRegistry
      .getState()
      .slots['right-panel'].find((entry) => entry.id === 'meadow:needs-update');
    expect(tab).toBeDefined();
    render(createElement(tab!.component));
    expect(screen.getByText('meadow needs an update to run safely.')).toBeInTheDocument();
    expect(
      screen.getByText('It was built for an older version of DorkOS. Ask its maker for an update.')
    ).toBeInTheDocument();
  });
});

describe('independent app loads', () => {
  it('activates two good apps and their Settings before a third import settles', async () => {
    vi.useFakeTimers();
    const records = [record('garden'), record('orchard', 'local'), record('pond')];
    const approvals = JSON.stringify(records);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => records }))
    );
    vi.mocked(importExtensionModule).mockImplementation(async (url) => {
      if (url.includes('/pond/')) return new Promise<ExtensionModule>(() => {});
      return moduleFor(url.includes('/garden/') ? 'Garden' : 'Orchard');
    });
    const initialization = loader.initialize();
    await vi.advanceTimersByTimeAsync(0);
    expect([...loader.getLoaded().keys()].sort()).toEqual(['garden', 'orchard']);
    expect(catalog(records).apps.map((app) => [app.id, app.state])).toEqual([
      ['garden', 'ok'],
      ['orchard', 'ok'],
      ['pond', 'starting'],
    ]);
    expect(
      useExtensionRegistry
        .getState()
        .slots['settings.tabs'].map((tab) => tab.id)
        .sort()
    ).toEqual(['garden:settings', 'orchard:settings']);
    await vi.advanceTimersByTimeAsync(EXTENSION_IMPORT_TIMEOUT_MS);
    await initialization;
    expect(catalog(records).apps.find((app) => app.id === 'pond')?.state).toBe('error');
    expect(useExtensionRegistry.getState().slots['settings.tabs'].map((tab) => tab.id)).toContain(
      'pond:load-error'
    );
    // Browser failure state never mutates the approval answer.
    expect(JSON.stringify(records)).toBe(approvals);
    const garden = loader.getLoaded().get('garden');
    vi.mocked(importExtensionModule).mockResolvedValue(moduleFor('Pond'));
    await loader.reloadExtensions(['pond']);
    expect(loader.getLoaded().get('garden')).toBe(garden);
    expect(importExtensionModule).toHaveBeenCalledTimes(4);
  });

  it('discards a timed-out import even when it later resolves, until an explicit retry', async () => {
    vi.useFakeTimers();
    const records = [record('pond')];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => records }))
    );
    let finish!: (module: ExtensionModule) => void;
    vi.mocked(importExtensionModule).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const initialization = loader.initialize();
    await vi.advanceTimersByTimeAsync(EXTENSION_IMPORT_TIMEOUT_MS);
    await initialization;
    const activate = vi.fn(moduleFor().activate);
    finish({ activate });
    await vi.advanceTimersByTimeAsync(0);
    expect(activate).not.toHaveBeenCalled();
    expect(loader.getLoaded().has('pond')).toBe(false);
    expect(useExtensionRegistry.getState().slots.pages).toEqual([]);
    expect(useExtensionRegistry.getState().slots['settings.tabs'].map((tab) => tab.id)).toEqual([
      'pond:load-error',
    ]);

    const failedTab = useExtensionRegistry.getState().slots['settings.tabs'][0]!;
    render(createElement(failedTab.component));
    expect(screen.getByText('Not working')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(importExtensionModule).toHaveBeenLastCalledWith(
      expect.stringMatching(/\/extensions\/pond\/bundle\?t=\d+/),
      expect.objectContaining({ id: 'pond' })
    );
    expect(loader.getLoaded().has('pond')).toBe(true);
    expect(useExtensionRegistry.getState().slots['settings.tabs'].map((tab) => tab.id)).toEqual([
      'pond:settings',
    ]);
  });

  it('retrying one app leaves another pending import free to activate', async () => {
    vi.useFakeTimers();
    const records = [record('pond'), record('garden', 'local')];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => records }))
    );
    let finishGarden!: (module: ExtensionModule) => void;
    let pondAttempts = 0;
    vi.mocked(importExtensionModule).mockImplementation((url) => {
      if (url.includes('/garden/'))
        return new Promise((resolve) => {
          finishGarden = resolve;
        });
      return ++pondAttempts === 1
        ? Promise.reject(new Error('unavailable'))
        : Promise.resolve(moduleFor('Pond'));
    });
    const initialization = loader.initialize();
    await vi.advanceTimersByTimeAsync(0);
    await loader.reloadExtensions(['pond']);
    finishGarden(moduleFor('Garden'));
    await vi.advanceTimersByTimeAsync(0);
    await initialization;
    expect([...loader.getLoaded().keys()].sort()).toEqual(['garden', 'pond']);
    expect(getExtensionClientStates().garden).toBe('ready');
  });

  it.each(['approval', 'withheld screens'])(
    'rechecks %s before retrying a failed app',
    async (gate) => {
      let records = [record('pond')];
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, json: async () => records }))
      );
      vi.mocked(importExtensionModule).mockRejectedValueOnce(new Error('unavailable'));
      await loader.initialize();
      records = [
        {
          ...records[0]!,
          ...(gate === 'approval' ? { approvedToRun: false } : { bundleReady: false }),
        },
      ];
      await loader.reloadExtensions(['pond']);
      expect(importExtensionModule).toHaveBeenCalledTimes(1);
      expect(loader.getLoaded().has('pond')).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  );

  it('isolates an activation throw and removes its partial page and Settings registrations', async () => {
    const records = [record('pond'), record('garden')];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => records }))
    );
    vi.mocked(importExtensionModule).mockResolvedValueOnce({
      activate(api) {
        moduleFor().activate(api);
        throw new Error('activation stopped');
      },
    });
    await loader.initialize();
    expect([...loader.getLoaded().keys()]).toEqual(['garden']);
    expect(useExtensionRegistry.getState().slots.pages.map((page) => page.id)).toEqual(['garden:']);
    expect(
      useExtensionRegistry
        .getState()
        .slots['settings.tabs'].map((tab) => tab.id)
        .sort()
    ).toEqual(['garden:settings', 'pond:load-error']);
    expect(getExtensionClientStates().pond).toBe('error');
  });
});

// Purpose: "Opened by Ledger" on a canvas tab, and a frame's call to another
// app, read DorkOS's listing; the first load fills it, not only a reload
// (DOR-3293, where only a reload did).
describe('the listing other surfaces read', () => {
  afterEach(() => {
    setExtensionNames({});
    setRunningApps([]);
  });

  it('names every app and knows which ones run, from the first load', async () => {
    const ledger = {
      ...record('ledger'),
      manifest: { ...record('ledger').manifest, name: 'Ledger' },
    };
    const off = { ...record('desk'), approvedToRun: false };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => [ledger, off] }))
    );
    await loader.initialize();
    expect(getExtensionNames()).toEqual({ ledger: 'Ledger', desk: 'desk' });
    expect(runningAppManifest('ledger')?.name).toBe('Ledger');
    expect(runningAppManifest('desk')).toBeNull();
  });
});
