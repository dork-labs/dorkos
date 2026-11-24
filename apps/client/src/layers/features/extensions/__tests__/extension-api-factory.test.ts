// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createExtensionAPI } from '../model/extension-api-factory';
import { setRunningApps } from '../frame/running-apps';
import { EXTENSION_CONTRIBUTION_KEYS, StartWorkError } from '@dorkos/extension-api';
import type { ExtensionAPIDeps } from '../model/types';
import type { ExtensionAPI } from '@dorkos/extension-api';
import {
  clearUndeclaredSlots,
  getUndeclaredSlots,
} from '@/layers/shared/lib/extension-undeclared-slots';
import type { UiCanvasContent, UiCommand } from '@dorkos/shared/types';

// Mock sonner toast before importing the factory
vi.mock('sonner', () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock ui-action-dispatcher
vi.mock('@/layers/shared/lib/ui-action-dispatcher', () => ({
  executeUiCommand: vi.fn(),
  revealForContent: vi.fn(),
}));
import { revealForContent } from '@/layers/shared/lib/ui-action-dispatcher';
import { executeUiCommand } from '@/layers/shared/lib/ui-action-dispatcher';

/** Every place declared, for tests of what a registration does once it is allowed. */
const DECLARES_ALL = {
  contributions: Object.fromEntries(EXTENSION_CONTRIBUTION_KEYS.map((key) => [key, true])),
  // And a person allowed every one (DOR-4282).
  allowedSlots: [...EXTENSION_CONTRIBUTION_KEYS],
};

/** Every place declared, none allowed: what a record without `allowedSlots` reads as. */
const DECLARES_ALL_UNALLOWED = { contributions: DECLARES_ALL.contributions };

// --- Helpers ---

function makeDeps(overrides: Partial<ExtensionAPIDeps> = {}): ExtensionAPIDeps {
  return {
    registry: {
      register: vi.fn().mockReturnValue(vi.fn()),
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
      getState: vi.fn().mockReturnValue({
        selectedCwd: '/projects/foo',
        sessionId: 'sess-abc',
      }),
      subscribe: vi.fn().mockReturnValue(vi.fn()),
    },
    availableSlots: new Set([
      'dashboard.sections',
      'sidebar.footer',
      'command-palette.items',
      'dialog',
      'settings.tabs',
      'right-panel',
    ] as const),
    registerCommandHandler: vi.fn(),
    unregisterCommandHandler: vi.fn(),
    eventBridge: {
      subscribe: vi.fn().mockReturnValue(vi.fn()),
    },
    ...overrides,
  };
}

/**
 * Minimal reactive store matching the plain single-listener subscribe contract
 * the factory expects. `setState` merges a partial and notifies listeners,
 * mirroring how the real app store drives extension subscriptions.
 */
function makeReactiveStore(initial: Record<string, unknown>) {
  let state = { ...initial };
  const listeners = new Set<(s: unknown, prev: unknown) => void>();
  return {
    getState: () => state,
    subscribe: (listener: (s: unknown, prev: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setState: (partial: Record<string, unknown>) => {
      const prev = state;
      state = { ...state, ...partial };
      for (const l of listeners) l(state, prev);
    },
  };
}

// --- Test suite ---

describe('createExtensionAPI', () => {
  let deps: ExtensionAPIDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = makeDeps();
  });

  // 2. registerComponent
  describe('registerComponent', () => {
    it('calls registry.register with a contribution containing the namespaced ID', () => {
      const { api } = createExtensionAPI('my-ext', deps, [], DECLARES_ALL);
      const FakeComponent = () => null;

      api.registerComponent('dashboard.sections', 'widget', FakeComponent);

      expect(deps.registry.register).toHaveBeenCalledOnce();
      const [slot, contribution] = vi.mocked(deps.registry.register).mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(slot).toBe('dashboard.sections');
      expect(contribution.id).toBe('my-ext:widget');
      expect(contribution.component).toBe(FakeComponent);
    });

    it('forwards visibleWhen for dashboard.sections so a section can hide itself', () => {
      const { api } = createExtensionAPI('my-ext', deps, [], DECLARES_ALL);
      const visibleWhen = () => false;

      api.registerComponent('dashboard.sections', 'widget', () => null, { visibleWhen });

      const [, contribution] = vi.mocked(deps.registry.register).mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      // The Activity tab re-evaluates this on every render, so forwarding it is
      // what makes "visibleWhen is honoured" true for extensions, not just for
      // built-in sections.
      expect(contribution.visibleWhen).toBe(visibleWhen);
    });

    it('warns when showIn names nothing, or names a page no page has', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { api } = createExtensionAPI('my-ext', deps, [], DECLARES_ALL);

      api.registerComponent('right-panel', 'a', () => null, {
        showIn: { pages: 'session' } as never,
      });
      expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('shows nowhere'));

      api.registerComponent('right-panel', 'b', () => null, { showIn: { pages: ['chat'] } });
      expect(warn).toHaveBeenLastCalledWith(expect.stringContaining("unknown page 'chat'"));

      warn.mockClear();
      api.registerComponent('right-panel', 'c', () => null, {
        showIn: { pages: ['session', 'x/other', '*'] },
      });
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  // 3. registerCommand
  describe('registerCommand', () => {
    it('registers a command palette contribution with namespaced IDs', () => {
      const { api } = createExtensionAPI('my-ext', deps, [], DECLARES_ALL);

      api.registerCommand('do-thing', 'Do the thing', vi.fn());

      expect(deps.registry.register).toHaveBeenCalledWith(
        'command-palette.items',
        expect.objectContaining({
          id: 'my-ext:do-thing',
          label: 'Do the thing',
          action: 'ext:my-ext:do-thing',
          category: 'feature',
          // So the palette can name the app from DorkOS's record (DOR-4282).
          extensionId: 'my-ext',
        })
      );
    });
  });

  // 4. registerDialog
  describe('registerDialog', () => {
    it('keeps its own open flag, which open() and close() drive', () => {
      const { api } = createExtensionAPI('my-ext', deps, [], DECLARES_ALL);
      const controls = api.registerDialog('my-dialog', () => null);
      const contribution = vi.mocked(deps.registry.register).mock.calls[0]![1] as {
        openState: { getSnapshot: () => boolean };
        openStateKey?: string;
      };

      // Not an app-store key: an extension cannot add one, so a key never opened.
      expect(contribution.openStateKey).toBeUndefined();
      expect(contribution.openState.getSnapshot()).toBe(false);
      controls.open();
      expect(contribution.openState.getSnapshot()).toBe(true);
      controls.close();
      expect(contribution.openState.getSnapshot()).toBe(false);
    });

    it('stamps the dialog with the app’s id, so the host names the app (DOR-4282)', () => {
      const { api } = createExtensionAPI('my-ext', deps, [], DECLARES_ALL);
      api.registerDialog('my-dialog', () => null);

      expect(deps.registry.register).toHaveBeenCalledWith(
        'dialog',
        expect.objectContaining({ id: 'my-ext:my-dialog', extensionId: 'my-ext' })
      );
    });

    it('gives each dialog its own open flag', () => {
      const { api } = createExtensionAPI('my-ext', deps, [], DECLARES_ALL);
      const first = api.registerDialog('one', () => null);
      api.registerDialog('two', () => null);
      const [one, two] = vi
        .mocked(deps.registry.register)
        .mock.calls.map(([, c]) => c as { openState: { getSnapshot: () => boolean } });

      first.open();
      expect(one!.openState.getSnapshot()).toBe(true);
      expect(two!.openState.getSnapshot()).toBe(false);
    });

    it("refuses registerComponent('dialog'), which could never open", () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { api, cleanups } = createExtensionAPI('my-ext', deps, [], DECLARES_ALL);

      const unsub = api.registerComponent('dialog', 'my-dialog', () => null);

      expect(deps.registry.register).not.toHaveBeenCalled();
      expect(cleanups).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('registerDialog'));
      expect(() => unsub()).not.toThrow();
      warn.mockRestore();
    });
  });

  // 6. executeCommand
  it('executeCommand delegates to executeUiCommand with agent origin (programmatic, never persists tab picks)', () => {
    const { api } = createExtensionAPI('my-ext', deps, [], DECLARES_ALL);
    const command = { action: 'open_command_palette' as const };

    api.executeCommand(command);

    expect(executeUiCommand).toHaveBeenCalledWith(deps.dispatcherContext, command, 'agent');
  });

  // 7. openCanvas
  it('openCanvas opens through the host store, stamped with this app’s own id (DOR-3293)', () => {
    const openCanvasDocument = vi.fn();
    const store = { openCanvasDocument } as unknown as ReturnType<
      ExtensionAPIDeps['dispatcherContext']['getStore']
    >;
    const ownDeps = makeDeps({
      dispatcherContext: { ...deps.dispatcherContext, getStore: () => store },
    });
    const { api } = createExtensionAPI('my-ext', ownDeps, [], DECLARES_ALL);
    const content: UiCanvasContent = { type: 'markdown', content: '# Hello' };

    api.openCanvas(content);

    // The id is this API's, never anything the app sends.
    expect(openCanvasDocument).toHaveBeenCalledWith(content, { extensionId: 'my-ext' });
    expect(revealForContent).toHaveBeenCalledWith(store, 'agent', content);
    // It is not an agent's open_canvas command, which could never carry the mark.
    expect(executeUiCommand).not.toHaveBeenCalled();
  });

  // 7b. Only the places the manifest declares (DOR-4282)
  describe('places the manifest does not declare', () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      clearUndeclaredSlots('my-ext');
    });
    afterEach(() => warn.mockRestore());

    it('adds neither a command nor a dialog for an app that declares only a Settings page', () => {
      const { api, cleanups } = createExtensionAPI('my-ext', deps, [], {
        contributions: { 'settings.tabs': true },
        allowedSlots: ['settings.tabs'],
      });

      const unsubCommand = api.registerCommand('sign-in', 'Sign in again', vi.fn());
      const dialog = api.registerDialog('sign-in', () => null);
      api.registerSettingsTab('prefs', 'Preferences', () => null);

      expect(vi.mocked(deps.registry.register).mock.calls.map(([slot]) => slot)).toEqual([
        'settings.tabs',
      ]);
      expect(deps.registerCommandHandler).not.toHaveBeenCalled();
      expect(cleanups).toHaveLength(1);
      expect(() => {
        unsubCommand();
        dialog.open();
        dialog.close();
      }).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('command-palette.items'));
      expect(getUndeclaredSlots('my-ext')).toEqual(['command-palette.items', 'dialog']);
    });

    it.each([
      ['a page', (api: ExtensionAPI) => api.registerPage('', () => null, { title: 'Home' })],
      [
        'a status bar item',
        (api: ExtensionAPI) => api.registerStatusBarItem('s', () => null, { label: 'S' }),
      ],
      ['a panel tab', (api: ExtensionAPI) => api.registerComponent('right-panel', 't', () => null)],
      [
        'an Activity section',
        (api: ExtensionAPI) => api.registerComponent('dashboard.sections', 'a', () => null),
      ],
      [
        'a sidebar item',
        (api: ExtensionAPI) => api.registerComponent('sidebar.footer', 'f', () => null),
      ],
      ['a Settings page', (api: ExtensionAPI) => api.registerSettingsTab('p', 'P', () => null)],
    ])('adds %s only when declared', (_what, register) => {
      const { api } = createExtensionAPI('my-ext', deps);
      register(api);
      expect(deps.registry.register).not.toHaveBeenCalled();

      const declared = createExtensionAPI('my-ext', deps, [], DECLARES_ALL);
      register(declared.api);
      expect(deps.registry.register).toHaveBeenCalledOnce();
    });

    it('opens nothing on the canvas without `canvas`', () => {
      const openCanvasDocument = vi.fn();
      const store = { openCanvasDocument } as unknown as ReturnType<
        ExtensionAPIDeps['dispatcherContext']['getStore']
      >;
      const ownDeps = makeDeps({
        dispatcherContext: { ...deps.dispatcherContext, getStore: () => store },
      });
      const { api } = createExtensionAPI('my-ext', ownDeps, [], {
        contributions: { pages: true },
      });

      api.openCanvas({ type: 'markdown', content: '# Hello' });

      expect(openCanvasDocument).not.toHaveBeenCalled();
      expect(getUndeclaredSlots('my-ext')).toEqual(['canvas']);
    });

    it.each([
      ['open_canvas', { action: 'open_canvas', content: { type: 'markdown', content: '# Hi' } }],
      [
        'update_canvas',
        { action: 'update_canvas', content: { type: 'markdown', content: '# Hi' } },
      ],
    ])('runs no %s command without `canvas`', (_action, command) => {
      const { api } = createExtensionAPI('my-ext', deps, [], { contributions: { pages: true } });

      api.executeCommand(command as UiCommand);

      expect(executeUiCommand).not.toHaveBeenCalled();
      expect(getUndeclaredSlots('my-ext')).toEqual(['canvas']);

      const declared = createExtensionAPI('my-ext', deps, [], {
        contributions: { canvas: true },
        allowedSlots: ['canvas'],
      });
      declared.api.executeCommand(command as UiCommand);
      expect(executeUiCommand).toHaveBeenCalledWith(deps.dispatcherContext, command, 'agent');
    });

    it('refuses a place set to anything but true', () => {
      const loose = { contributions: { 'command-palette.items': 'yes' } } as unknown as {
        contributions: Record<string, boolean>;
      };
      const { api } = createExtensionAPI('my-ext', deps, [], loose);
      api.registerCommand('go', 'Go', vi.fn());
      expect(deps.registry.register).not.toHaveBeenCalled();
    });

    // An app approved before places were recorded keeps its old places
    // while DorkOS's record says so; nothing else, whatever the record lists.
    it('keeps a panel tab, Settings page and page under grace, and nothing else', () => {
      const { api } = createExtensionAPI('my-ext', deps, [], {
        allowedSlots: [
          'right-panel',
          'settings.tabs',
          'pages',
          'command-palette.items',
          'dialog',
          'status-bar',
          'canvas',
        ],
      });

      api.registerComponent('right-panel', 't', () => null);
      api.registerSettingsTab('p', 'P', () => null);
      api.registerPage('', () => null, { title: 'Home' });
      api.registerCommand('go', 'Go', vi.fn());
      api.registerDialog('d', () => null);
      api.registerStatusBarItem('s', () => null, { label: 'S' });
      api.openCanvas({ type: 'markdown', content: '# Hi' });

      expect(
        vi
          .mocked(deps.registry.register)
          .mock.calls.map(([slot]) => slot)
          .sort()
      ).toEqual(['pages', 'right-panel', 'settings.tabs'].sort());
      expect(getUndeclaredSlots('my-ext')).toEqual([
        'command-palette.items',
        'dialog',
        'status-bar',
        'canvas',
      ]);
    });

    // Purpose: a place the manifest declares but no person allowed yet is
    // refused and never drawn, while the places they did allow still work
    // (DOR-4282, option C). It is waiting, not undeclared, so nothing asks
    // its maker to update it.
    it('refuses a declared place a person has not allowed, and keeps the allowed ones', () => {
      const openCanvasDocument = vi.fn();
      const store = { openCanvasDocument } as unknown as ReturnType<
        ExtensionAPIDeps['dispatcherContext']['getStore']
      >;
      const ownDeps = makeDeps({
        dispatcherContext: { ...deps.dispatcherContext, getStore: () => store },
      });
      const { api } = createExtensionAPI('my-ext', ownDeps, [], {
        contributions: {
          'right-panel': true,
          'settings.tabs': true,
          pages: true,
          'status-bar': true,
          'command-palette.items': true,
          dialog: true,
          canvas: true,
        },
        allowedSlots: ['right-panel', 'settings.tabs'],
      });

      api.registerComponent('right-panel', 't', () => null);
      api.registerSettingsTab('p', 'P', () => null);
      api.registerPage('', () => null, { title: 'Home' });
      api.registerStatusBarItem('s', () => null, { label: 'S' });
      api.registerCommand('go', 'Go', vi.fn());
      const dialog = api.registerDialog('d', () => null);
      api.openCanvas({ type: 'markdown', content: '# Hi' });

      expect(
        vi
          .mocked(ownDeps.registry.register)
          .mock.calls.map(([slot]) => slot)
          .sort()
      ).toEqual(['right-panel', 'settings.tabs'].sort());
      expect(ownDeps.registerCommandHandler).not.toHaveBeenCalled();
      expect(openCanvasDocument).not.toHaveBeenCalled();
      expect(() => dialog.open()).not.toThrow();
      expect(getUndeclaredSlots('my-ext')).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('has not allowed "pages"'));
    });

    // Purpose: fail-closed, the manifest alone never opens a place.
    it('refuses every place when the record carries no allowed places', () => {
      const { api } = createExtensionAPI('my-ext', deps, [], DECLARES_ALL_UNALLOWED);
      api.registerPage('', () => null, { title: 'Home' });
      api.registerComponent('right-panel', 't', () => null);
      expect(deps.registry.register).not.toHaveBeenCalled();
    });
  });

  // An extension's `navigate` argument is a string the extension author wrote,
  // and it used to reach the router unchecked (DOR-924).
  it.each([
    '/not-a-route',
    'https://evil.example/steal',
    '//evil.example/steal',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
  ])('navigate refuses %s rather than handing it to the router', (path) => {
    const { api } = createExtensionAPI('my-ext', deps, [], DECLARES_ALL);

    api.navigate(path);

    expect(deps.navigate).not.toHaveBeenCalled();
  });

  describe('navigate to another app’s page (DOR-3293)', () => {
    const caller = { capabilities: { http: { apps: [{ id: 'ledger', navigate: true }, 'desk'] } } };
    beforeEach(() =>
      setRunningApps([
        {
          id: 'ledger',
          status: 'compiled',
          approvedToRun: true,
          manifest: { id: 'ledger', name: 'Ledger', version: '1.0.0' },
        },
      ] as never)
    );
    afterEach(() => setRunningApps([]));

    it('opens a page of an app this one lists, by the item path alone', () => {
      const deps = makeDeps();
      const { api } = createExtensionAPI('my-ext', deps, [], caller);
      api.navigate('/x/ledger/item/entry/e-17');
      expect(deps.navigate).toHaveBeenCalledWith({ to: '/x/ledger/item/entry/e-17' });
    });

    it.each([
      ['a query', '/x/ledger/item/entry/e-17?approve=1'],
      ['a hash', '/x/ledger/item/entry/e-17#approve'],
      ['an encoded segment', '/x/ledger/item/entry/e%2F17'],
      ['a page of an app it does not list', '/x/quill/item/entry/e-17'],
      ['a page of an app it lists only to call', '/x/desk/item/entry/e-17'],
      ['a dot-dot that resolves to another app', '/x/my-ext/../ledger/item'],
    ])('refuses %s', (_name, path) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const deps = makeDeps();
      const { api } = createExtensionAPI('my-ext', deps, [], caller);
      api.navigate(path);
      expect(deps.navigate).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('refuses an app that is not running', () => {
      setRunningApps([]);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const deps = makeDeps();
      const { api } = createExtensionAPI('my-ext', deps, [], caller);
      api.navigate('/x/ledger/item/entry/e-17');
      expect(deps.navigate).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  // How an extension opens the Inbox on one of its decisions (DOR-2577): a
  // search-only path keeps the person on the page they are on.
  it('navigate opens the Inbox over the current page for a search-only ?inbox=', () => {
    window.history.replaceState(null, '', '/x/my-ext/p/dorkos?tab=runs');
    try {
      const { api } = createExtensionAPI('my-ext', deps, [], DECLARES_ALL);

      api.navigate('?inbox=01J0000000000000000000000D');

      expect(deps.navigate).toHaveBeenCalledWith({
        to: '/x/my-ext/p/dorkos?tab=runs&inbox=01J0000000000000000000000D',
      });
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  // 9. getState
  describe('getState', () => {
    it('says whether Require login is on', () => {
      vi.mocked(deps.appStore.getState).mockReturnValue({ requireLogin: true });
      const { api } = createExtensionAPI('my-ext', deps, [], DECLARES_ALL);
      expect(api.getState().requireLogin).toBe(true);
    });

    it('resolves agentId from the store currentAgentId (cwd matched an agent)', () => {
      vi.mocked(deps.appStore.getState).mockReturnValue({
        selectedCwd: '/home/kai/project',
        sessionId: 'sess-xyz',
        currentAgentId: '01HZ0000000000000000000001',
      });
      const { api } = createExtensionAPI('my-ext', deps, [], DECLARES_ALL);

      expect(api.getState().agentId).toBe('01HZ0000000000000000000001');
    });
  });

  // 10. subscribe
  describe('subscribe', () => {
    it('fires the callback with the new agentId when the cwd resolves to a different agent', () => {
      const store = makeReactiveStore({
        selectedCwd: '/p/a',
        sessionId: 's1',
        currentAgentId: 'agent-a',
      });
      deps = makeDeps({ appStore: store as unknown as ExtensionAPIDeps['appStore'] });
      const { api } = createExtensionAPI('my-ext', deps, [], DECLARES_ALL);
      const received: unknown[] = [];

      api.subscribe(
        (s) => s.agentId,
        (v) => received.push(v)
      );
      // A cwd switch updates both the cwd and the resolved agent id.
      store.setState({ selectedCwd: '/p/b', currentAgentId: 'agent-b' });

      expect(received).toEqual(['agent-b']);
    });

    it('does not fire when the selected agentId is unchanged', () => {
      const store = makeReactiveStore({
        selectedCwd: '/p/a',
        sessionId: 's1',
        currentAgentId: 'agent-a',
      });
      deps = makeDeps({ appStore: store as unknown as ExtensionAPIDeps['appStore'] });
      const { api } = createExtensionAPI('my-ext', deps, [], DECLARES_ALL);
      const callback = vi.fn();

      api.subscribe((s) => s.agentId, callback);
      // An unrelated field changes; the projected agentId does not.
      store.setState({ sessionId: 's2' });

      expect(callback).not.toHaveBeenCalled();
    });
  });

  // 11. loadData
  describe('loadData', () => {
    it('fetches from /api/extensions/{id}/data and returns parsed JSON', async () => {
      const payload = { theme: 'dark' };
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          status: 200,
          ok: true,
          json: vi.fn().mockResolvedValue(payload),
        })
      );
      const { api } = createExtensionAPI('my-ext', deps, [], DECLARES_ALL);

      const result = await api.loadData();

      expect(fetch).toHaveBeenCalledWith('/api/extensions/my-ext/data');
      expect(result).toEqual(payload);

      vi.unstubAllGlobals();
    });

    it('returns null when the server responds with 204', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          status: 204,
          json: vi.fn(),
        })
      );
      const { api } = createExtensionAPI('my-ext', deps, [], DECLARES_ALL);

      const result = await api.loadData();

      expect(result).toBeNull();
      vi.unstubAllGlobals();
    });

    // 12. saveData
    it('saveData PUTs JSON to /api/extensions/{id}/data', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, ok: true }));
      const { api } = createExtensionAPI('my-ext', deps, [], DECLARES_ALL);
      const data = { count: 42 };

      await api.saveData(data);

      expect(fetch).toHaveBeenCalledWith('/api/extensions/my-ext/data', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-DorkOS-Extension': 'my-ext' },
        body: JSON.stringify(data),
      });
      vi.unstubAllGlobals();
    });
  });

  // 13. notify
  describe('inbox decisions and project settings (spec flow-multiproject §7)', () => {
    const decision = {
      id: '01J0000000000000000000000D',
      extensionId: 'my-ext',
      extensionName: 'Mine',
      key: 'ship',
      title: 'Ship it?',
      why: 'It is ready.',
      detail: null,
      project: { root: '/repos/dorkos', name: 'dorkos' },
      projectLabel: null,
      since: null,
      actions: { kind: 'yes-no', approveLabel: 'Ship it', rejectLabel: 'Send it back' },
      link: null,
      raisedAt: '2026-09-29T09:00:00.000Z',
      needsYou: false,
      watch: null,
      revision: 0,
    };

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('answers through this extension’s own scoped route and follows its own /x/ page', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          resolved: true,
          message: 'Shipping.',
          navigate: '/x/my-ext/p/dorkos',
          offer: null,
          watch: null,
        }),
      });
      vi.stubGlobal('fetch', fetchMock);
      const { api } = createExtensionAPI('my-ext', deps, [], DECLARES_ALL);

      const result = await api.answerDecision(decision.id, { action: 'approve' });

      expect(fetchMock.mock.calls[0][0]).toBe(
        `/api/extensions/my-ext/decisions/${decision.id}/action`
      );
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ action: 'approve' });
      expect(result).toEqual({
        resolved: true,
        message: 'Shipping.',
        navigate: '/x/my-ext/p/dorkos',
        watch: null,
      });
      expect(deps.navigate).toHaveBeenCalledWith({ to: '/x/my-ext/p/dorkos' });
    });

    it('never follows a navigate to another extension’s page', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: vi.fn().mockResolvedValue({
            resolved: true,
            message: null,
            navigate: '/x/other-ext/p/dorkos',
            offer: null,
            watch: null,
          }),
        })
      );
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Even one this app lists: only the app's own screens may open another app's page.
      setRunningApps([
        {
          id: 'other-ext',
          status: 'compiled',
          approvedToRun: true,
          manifest: { id: 'other-ext', name: 'Other', version: '1.0.0' },
        },
      ] as never);
      const { api } = createExtensionAPI('my-ext', deps, [], {
        capabilities: { http: { apps: [{ id: 'other-ext', navigate: true }] } },
      });
      await api.answerDecision(decision.id, { action: 'approve' });
      expect(deps.navigate).not.toHaveBeenCalled();
      setRunningApps([]);
      warn.mockRestore();
    });

    it('checks what project settings come back against their schema', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: vi.fn().mockResolvedValue({ value: 1, updatedAt: 42, updatedBy: 'robot' }),
        })
      );
      const { api } = createExtensionAPI('my-ext', deps, [], DECLARES_ALL);
      await expect(api.projectSettings.get('/repos/dorkos')).rejects.toThrow();
    });

    it('throws with the server’s code when an answer is refused', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 409,
          json: vi.fn().mockResolvedValue({
            type: 'urn:dorkos:problem:already_resolved',
            title: 'This was already settled.',
            status: 409,
            code: 'already_resolved',
            detail: 'This was already settled.',
          }),
        })
      );
      const { api } = createExtensionAPI('my-ext', deps, [], DECLARES_ALL);
      await expect(api.answerDecision(decision.id, { action: 'approve' })).rejects.toMatchObject({
        message: 'This was already settled.',
        code: 'already_resolved',
      });
    });

    it('reads and writes per-project settings through the scoped routes', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: vi.fn().mockResolvedValue({
            value: { autonomy: 'ask-me-first' },
            updatedAt: '2026-09-29T09:00:00.000Z',
            updatedBy: 'extension-page',
          }),
        })
        .mockResolvedValueOnce({ ok: true, status: 204, json: vi.fn() });
      vi.stubGlobal('fetch', fetchMock);
      const { api } = createExtensionAPI('my-ext', deps, [], DECLARES_ALL);

      expect(await api.projectSettings.get('/repos/my.app')).toEqual({ autonomy: 'ask-me-first' });
      expect(fetchMock.mock.calls[0][0]).toBe(
        '/api/extensions/my-ext/project-settings?project=%2Frepos%2Fmy.app'
      );
      await api.projectSettings.set('/repos/my.app', { autonomy: 'just-do-it' });
      expect(fetchMock.mock.calls[1][0]).toBe('/api/extensions/my-ext/project-settings');
      expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'PUT' });
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
        project: '/repos/my.app',
        value: { autonomy: 'just-do-it' },
      });
    });
  });

  describe('startWork (spec flow-multiproject §7.7)', () => {
    it('preserves the no-tools warning from an agentless Codex start', async () => {
      const response = {
        sessionId: 'chat-new',
        warnings: [{ code: 'NO_DORKOS_TOOLS', message: 'This chat has no DorkOS tools.' }],
      };
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => response,
        })
      );
      const { api } = createExtensionAPI('my-ext', deps, [], DECLARES_ALL);
      await expect(api.startWork(input)).resolves.toEqual(response);
    });

    const input = {
      project: '/repos/dorkos',
      prompt: 'Sort the new ideas.',
      title: 'Sorting 12 new ideas in dorkos',
      reason: '12 new ideas were waiting to be sorted',
    };

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('posts to this extension’s own route, answers the new chat, and navigates nowhere', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ sessionId: 'chat-new' }),
      });
      vi.stubGlobal('fetch', fetchMock);
      const { api } = createExtensionAPI('my-ext', deps, [], DECLARES_ALL);

      await expect(api.startWork(input)).resolves.toEqual({ sessionId: 'chat-new' });
      expect(fetchMock.mock.calls[0][0]).toBe('/api/extensions/my-ext/start-work');
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(input);
      expect(deps.navigate).not.toHaveBeenCalled();
    });

    it('throws a StartWorkError carrying the refusal’s code and sentence', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 429,
          json: vi.fn().mockResolvedValue({
            type: 'urn:dorkos:problem:rate_limited',
            title: 'Too many requests. Wait a moment, then try again.',
            status: 429,
            code: 'rate_limited',
            detail: 'Mine has started a lot of chats in the last hour. Try again later.',
          }),
        })
      );
      const { api } = createExtensionAPI('my-ext', deps, [], DECLARES_ALL);
      const err = await api.startWork(input).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StartWorkError);
      expect(err).toMatchObject({
        name: 'StartWorkError',
        code: 'start_limit',
        message: 'Mine has started a lot of chats in the last hour. Try again later.',
      });
    });
  });

  // 15. Automatic cleanup tracking
  describe('automatic cleanup tracking', () => {
    it('collects cleanups from multiple register* calls in order', () => {
      const unsub1 = vi.fn();
      const unsub2 = vi.fn();
      const unsub3 = vi.fn();
      vi.mocked(deps.registry.register)
        .mockReturnValueOnce(unsub1)
        .mockReturnValueOnce(unsub2)
        .mockReturnValueOnce(unsub3);
      const { api, cleanups } = createExtensionAPI('my-ext', deps, [], DECLARES_ALL);

      api.registerComponent('dashboard.sections', 'w1', () => null);
      api.registerCommand('cmd', 'Label', vi.fn());
      api.registerSettingsTab('prefs', 'Prefs', () => null);

      expect(cleanups).toHaveLength(3);
      // registerComponent and registerSettingsTab push raw unsubs
      expect(cleanups[0]).toBe(unsub1);
      expect(cleanups[2]).toBe(unsub3);
      // registerCommand pushes a wrapper that also unregisters the handler
      cleanups[1]();
      expect(unsub2).toHaveBeenCalled();
      expect(deps.unregisterCommandHandler).toHaveBeenCalledWith('ext:my-ext:cmd');
    });
  });

  // 16. events.subscribe — manifest capability gating
  describe('events.subscribe', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('drops undeclared kinds, warns, and only forwards the allowed ones', () => {
      const { api } = createExtensionAPI('my-ext', deps, ['session']);
      const handler = vi.fn();

      api.events.subscribe(['session.started', 'tool.activity'], handler);

      expect(deps.eventBridge.subscribe).toHaveBeenCalledWith(['session.started'], handler);
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(String(warnSpy.mock.calls[0][0])).toContain('tool.activity');
    });

    it('returns a no-op and does not touch the bridge when every kind is undeclared', () => {
      const { api, cleanups } = createExtensionAPI('my-ext', deps, []);
      const handler = vi.fn();

      const unsub = api.events.subscribe(['turn.completed'], handler);

      expect(deps.eventBridge.subscribe).not.toHaveBeenCalled();
      expect(cleanups).toHaveLength(0);
      expect(() => unsub()).not.toThrow();
      expect(warnSpy).toHaveBeenCalledOnce();
    });

    it('cleans up the bridge subscription on deactivate (via cleanups)', () => {
      const bridgeUnsub = vi.fn();
      vi.mocked(deps.eventBridge.subscribe).mockReturnValue(bridgeUnsub);
      const { api, cleanups } = createExtensionAPI('my-ext', deps, ['tool']);

      api.events.subscribe(['tool.activity'], vi.fn());
      // The loader runs every cleanup on deactivate.
      for (const cleanup of cleanups) cleanup();

      expect(bridgeUnsub).toHaveBeenCalled();
    });
  });
});
