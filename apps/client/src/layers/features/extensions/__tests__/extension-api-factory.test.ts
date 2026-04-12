import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createExtensionAPI } from '../model/extension-api-factory';
import type { ExtensionAPIDeps } from '../model/types';
import type { UiCanvasContent } from '@dorkos/shared/types';

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
}));

import { toast } from 'sonner';
import { executeUiCommand } from '@/layers/shared/lib/ui-action-dispatcher';

// --- Helpers ---

function makeDeps(overrides: Partial<ExtensionAPIDeps> = {}): ExtensionAPIDeps {
  return {
    registry: {
      register: vi.fn().mockReturnValue(vi.fn()),
    },
    dispatcherContext: {
      store: {} as ExtensionAPIDeps['dispatcherContext']['store'],
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
      'sidebar.tabs',
      'sidebar.footer',
      'header.actions',
      'command-palette.items',
      'dialog',
      'settings.tabs',
      'right-panel',
    ] as const),
    registerCommandHandler: vi.fn(),
    unregisterCommandHandler: vi.fn(),
    ...overrides,
  };
}

// --- Test suite ---

describe('createExtensionAPI', () => {
  let deps: ExtensionAPIDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = makeDeps();
  });

  // 1. id field
  it('exposes the extension ID as a readonly property', () => {
    const { api } = createExtensionAPI('my-ext', deps);
    expect(api.id).toBe('my-ext');
  });

  // 2. registerComponent
  describe('registerComponent', () => {
    it('calls registry.register with a contribution containing the namespaced ID', () => {
      const { api } = createExtensionAPI('my-ext', deps);
      const FakeComponent = () => null;

      api.registerComponent('dashboard.sections', 'widget', FakeComponent);

      expect(deps.registry.register).toHaveBeenCalledOnce();
      const [slot, contribution] = vi.mocked(deps.registry.register).mock.calls[0];
      expect(slot).toBe('dashboard.sections');
      expect(contribution.id).toBe('my-ext:widget');
      expect(contribution.component).toBe(FakeComponent);
    });

    it('respects the priority option', () => {
      const { api } = createExtensionAPI('my-ext', deps);
      api.registerComponent('dashboard.sections', 'widget', () => null, { priority: 10 });

      const [, contribution] = vi.mocked(deps.registry.register).mock.calls[0];
      expect(contribution.priority).toBe(10);
    });

    it('returns the unsubscribe function from registry.register', () => {
      const unsub = vi.fn();
      vi.mocked(deps.registry.register).mockReturnValueOnce(unsub);
      const { api } = createExtensionAPI('my-ext', deps);

      const returned = api.registerComponent('dashboard.sections', 'widget', () => null);
      expect(returned).toBe(unsub);
    });

    it('adds the unsubscribe function to cleanups', () => {
      const unsub = vi.fn();
      vi.mocked(deps.registry.register).mockReturnValueOnce(unsub);
      const { api, cleanups } = createExtensionAPI('my-ext', deps);

      api.registerComponent('dashboard.sections', 'widget', () => null);
      expect(cleanups).toContain(unsub);
    });
  });

  // 3. registerCommand
  describe('registerCommand', () => {
    it('registers a command palette contribution with namespaced IDs', () => {
      const { api } = createExtensionAPI('my-ext', deps);

      api.registerCommand('do-thing', 'Do the thing', vi.fn());

      expect(deps.registry.register).toHaveBeenCalledWith(
        'command-palette.items',
        expect.objectContaining({
          id: 'my-ext:do-thing',
          label: 'Do the thing',
          action: 'ext:my-ext:do-thing',
          category: 'feature',
        })
      );
    });

    it('uses the provided icon and shortcut', () => {
      const { api } = createExtensionAPI('my-ext', deps);

      api.registerCommand('do-thing', 'Do the thing', vi.fn(), {
        icon: 'zap',
        shortcut: '⌘D',
      });

      const [, contribution] = vi.mocked(deps.registry.register).mock.calls[0];
      expect(contribution.icon).toBe('zap');
      expect(contribution.shortcut).toBe('⌘D');
    });

    it('falls back to "puzzle" icon when none provided', () => {
      const { api } = createExtensionAPI('my-ext', deps);
      api.registerCommand('do-thing', 'Label', vi.fn());

      const [, contribution] = vi.mocked(deps.registry.register).mock.calls[0];
      expect(contribution.icon).toBe('puzzle');
    });

    it('registers the action handler with the correct action ID', () => {
      const cb = vi.fn();
      const { api } = createExtensionAPI('my-ext', deps);

      api.registerCommand('do-thing', 'Label', cb);

      expect(deps.registerCommandHandler).toHaveBeenCalledWith('ext:my-ext:do-thing', cb);
    });

    it('adds the registry unsub to cleanups', () => {
      const unsub = vi.fn();
      vi.mocked(deps.registry.register).mockReturnValueOnce(unsub);
      const { api, cleanups } = createExtensionAPI('my-ext', deps);

      api.registerCommand('do-thing', 'Label', vi.fn());
      // Cleanup is a wrapper that calls both registry unsub and command handler removal
      expect(cleanups).toHaveLength(1);
      cleanups[0]();
      expect(unsub).toHaveBeenCalled();
      expect(deps.unregisterCommandHandler).toHaveBeenCalledWith('ext:my-ext:do-thing');
    });
  });

  // 4. registerDialog
  describe('registerDialog', () => {
    it('registers a dialog contribution with the dialog slot', () => {
      const { api } = createExtensionAPI('my-ext', deps);
      const DialogComponent = () => null;

      api.registerDialog('my-dialog', DialogComponent);

      expect(deps.registry.register).toHaveBeenCalledWith(
        'dialog',
        expect.objectContaining({
          id: 'my-ext:my-dialog',
          component: DialogComponent,
        })
      );
    });

    it('returns open and close controls', () => {
      const { api } = createExtensionAPI('my-ext', deps);
      const controls = api.registerDialog('my-dialog', () => null);

      expect(typeof controls.open).toBe('function');
      expect(typeof controls.close).toBe('function');
    });

    it('open/close do not throw', () => {
      const { api } = createExtensionAPI('my-ext', deps);
      const controls = api.registerDialog('my-dialog', () => null);

      expect(() => controls.open()).not.toThrow();
      expect(() => controls.close()).not.toThrow();
    });

    it('adds the registry unsub to cleanups', () => {
      const unsub = vi.fn();
      vi.mocked(deps.registry.register).mockReturnValueOnce(unsub);
      const { api, cleanups } = createExtensionAPI('my-ext', deps);

      api.registerDialog('my-dialog', () => null);
      expect(cleanups).toContain(unsub);
    });
  });

  // 5. registerSettingsTab
  describe('registerSettingsTab', () => {
    it('registers a settings tab with the namespaced ID and label', () => {
      const { api } = createExtensionAPI('my-ext', deps);
      const TabComponent = () => null;

      api.registerSettingsTab('prefs', 'Preferences', TabComponent);

      expect(deps.registry.register).toHaveBeenCalledWith(
        'settings.tabs',
        expect.objectContaining({
          id: 'my-ext:prefs',
          label: 'Preferences',
          component: TabComponent,
        })
      );
    });

    it('adds the registry unsub to cleanups', () => {
      const unsub = vi.fn();
      vi.mocked(deps.registry.register).mockReturnValueOnce(unsub);
      const { api, cleanups } = createExtensionAPI('my-ext', deps);

      api.registerSettingsTab('prefs', 'Prefs', () => null);
      expect(cleanups).toContain(unsub);
    });
  });

  // 6. executeCommand
  it('executeCommand delegates to executeUiCommand with the dispatcher context', () => {
    const { api } = createExtensionAPI('my-ext', deps);
    const command = { action: 'open_command_palette' as const };

    api.executeCommand(command);

    expect(executeUiCommand).toHaveBeenCalledWith(deps.dispatcherContext, command);
  });

  // 7. openCanvas
  it('openCanvas dispatches an open_canvas command with the provided content', () => {
    const { api } = createExtensionAPI('my-ext', deps);
    const content: UiCanvasContent = { type: 'markdown', content: '# Hello' };

    api.openCanvas(content);

    expect(executeUiCommand).toHaveBeenCalledWith(deps.dispatcherContext, {
      action: 'open_canvas',
      content,
    });
  });

  // 8. navigate
  it('navigate calls deps.navigate with the correct path', () => {
    const { api } = createExtensionAPI('my-ext', deps);

    api.navigate('/agents');

    expect(deps.navigate).toHaveBeenCalledWith({ to: '/agents' });
  });

  // 9. getState
  describe('getState', () => {
    it('projects selectedCwd and sessionId from the app store', () => {
      vi.mocked(deps.appStore.getState).mockReturnValue({
        selectedCwd: '/home/kai/project',
        sessionId: 'sess-xyz',
      });
      const { api } = createExtensionAPI('my-ext', deps);

      const state = api.getState();

      expect(state).toEqual({
        currentCwd: '/home/kai/project',
        activeSessionId: 'sess-xyz',
        agentId: null,
      });
    });

    it('returns null for missing fields', () => {
      vi.mocked(deps.appStore.getState).mockReturnValue({});
      const { api } = createExtensionAPI('my-ext', deps);

      const state = api.getState();

      expect(state.currentCwd).toBeNull();
      expect(state.activeSessionId).toBeNull();
      expect(state.agentId).toBeNull();
    });
  });

  // 10. subscribe
  describe('subscribe', () => {
    it('subscribes to the app store via a projected selector', () => {
      const { api } = createExtensionAPI('my-ext', deps);
      const selector = vi.fn((s) => s.currentCwd);
      const callback = vi.fn();

      api.subscribe(selector, callback);

      expect(deps.appStore.subscribe).toHaveBeenCalledOnce();
    });

    it('adds the unsubscribe function to cleanups', () => {
      const unsub = vi.fn();
      vi.mocked(deps.appStore.subscribe).mockReturnValueOnce(unsub);
      const { api, cleanups } = createExtensionAPI('my-ext', deps);

      api.subscribe(() => null, vi.fn());
      expect(cleanups).toContain(unsub);
    });

    it('returns the unsubscribe function', () => {
      const unsub = vi.fn();
      vi.mocked(deps.appStore.subscribe).mockReturnValueOnce(unsub);
      const { api } = createExtensionAPI('my-ext', deps);

      const returned = api.subscribe(() => null, vi.fn());
      expect(returned).toBe(unsub);
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
      const { api } = createExtensionAPI('my-ext', deps);

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
      const { api } = createExtensionAPI('my-ext', deps);

      const result = await api.loadData();

      expect(result).toBeNull();
      vi.unstubAllGlobals();
    });
  });

  // 12. saveData
  it('saveData PUTs JSON to /api/extensions/{id}/data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, ok: true }));
    const { api } = createExtensionAPI('my-ext', deps);
    const data = { count: 42 };

    await api.saveData(data);

    expect(fetch).toHaveBeenCalledWith('/api/extensions/my-ext/data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    vi.unstubAllGlobals();
  });

  // 13. notify
  describe('notify', () => {
    it('calls toast.info by default', () => {
      const { api } = createExtensionAPI('my-ext', deps);
      api.notify('Hello world');

      expect(toast.info).toHaveBeenCalledWith('Hello world');
    });

    it('calls toast.success when type is "success"', () => {
      const { api } = createExtensionAPI('my-ext', deps);
      api.notify('Done!', { type: 'success' });

      expect(toast.success).toHaveBeenCalledWith('Done!');
    });

    it('calls toast.error when type is "error"', () => {
      const { api } = createExtensionAPI('my-ext', deps);
      api.notify('Failed', { type: 'error' });

      expect(toast.error).toHaveBeenCalledWith('Failed');
    });

    it('calls toast.info when type is explicitly "info"', () => {
      const { api } = createExtensionAPI('my-ext', deps);
      api.notify('FYI', { type: 'info' });

      expect(toast.info).toHaveBeenCalledWith('FYI');
    });
  });

  // 14. isSlotAvailable
  describe('isSlotAvailable', () => {
    it('returns true for slots in the available set', () => {
      const { api } = createExtensionAPI('my-ext', deps);
      expect(api.isSlotAvailable('dashboard.sections')).toBe(true);
      expect(api.isSlotAvailable('command-palette.items')).toBe(true);
    });

    it('returns false for slots not in the available set', () => {
      deps = makeDeps({ availableSlots: new Set(['dashboard.sections'] as const) });
      const { api } = createExtensionAPI('my-ext', deps);
      expect(api.isSlotAvailable('sidebar.tabs')).toBe(false);
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
      const { api, cleanups } = createExtensionAPI('my-ext', deps);

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

    it('starts with an empty cleanups array', () => {
      const { cleanups } = createExtensionAPI('my-ext', deps);
      expect(cleanups).toHaveLength(0);
    });
  });
});
