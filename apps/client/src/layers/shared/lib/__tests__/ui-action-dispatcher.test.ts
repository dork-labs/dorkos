import { describe, it, expect, vi } from 'vitest';
import {
  executeUiCommand,
  type DispatcherContext,
  type DispatcherStore,
} from '../ui-action-dispatcher';

// --- Mock store factory ---

function makeMockStore(overrides: Partial<DispatcherStore> = {}): DispatcherStore {
  return {
    setSidebarOpen: vi.fn(),
    setSidebarActiveTab: vi.fn(),
    settingsOpen: false,
    setSettingsOpen: vi.fn(),
    tasksOpen: false,
    setTasksOpen: vi.fn(),
    relayOpen: false,
    setRelayOpen: vi.fn(),
    pickerOpen: false,
    setPickerOpen: vi.fn(),
    setGlobalPaletteOpen: vi.fn(),
    setCanvasOpen: vi.fn(),
    setCanvasContent: vi.fn(),
    setCanvasPreferredWidth: vi.fn(),
    ...overrides,
  };
}

function makeMockCtx(storeOverrides: Partial<DispatcherStore> = {}): DispatcherContext {
  return {
    store: makeMockStore(storeOverrides),
    setTheme: vi.fn(),
    scrollToMessage: vi.fn(),
    switchAgent: vi.fn(),
  };
}

// --- Panel commands ---

describe('executeUiCommand — panel commands', () => {
  it('open_panel calls the correct setter with true', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'open_panel', panel: 'tasks' });
    expect(ctx.store.setTasksOpen).toHaveBeenCalledWith(true);
  });

  it('close_panel calls the correct setter with false', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'close_panel', panel: 'settings' });
    expect(ctx.store.setSettingsOpen).toHaveBeenCalledWith(false);
  });

  it('toggle_panel opens a closed panel', () => {
    const ctx = makeMockCtx({ relayOpen: false });
    executeUiCommand(ctx, { action: 'toggle_panel', panel: 'relay' });
    expect(ctx.store.setRelayOpen).toHaveBeenCalledWith(true);
  });

  it('toggle_panel closes an open panel', () => {
    const ctx = makeMockCtx({ relayOpen: true });
    executeUiCommand(ctx, { action: 'toggle_panel', panel: 'relay' });
    expect(ctx.store.setRelayOpen).toHaveBeenCalledWith(false);
  });

  it('open_panel picker calls setPickerOpen', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'open_panel', panel: 'picker' });
    expect(ctx.store.setPickerOpen).toHaveBeenCalledWith(true);
  });

  it('close_panel settings calls setSettingsOpen with false', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'close_panel', panel: 'settings' });
    expect(ctx.store.setSettingsOpen).toHaveBeenCalledWith(false);
  });
});

// --- Sidebar commands ---

describe('executeUiCommand — sidebar commands', () => {
  it('open_sidebar calls setSidebarOpen(true)', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'open_sidebar' });
    expect(ctx.store.setSidebarOpen).toHaveBeenCalledWith(true);
  });

  it('close_sidebar calls setSidebarOpen(false)', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'close_sidebar' });
    expect(ctx.store.setSidebarOpen).toHaveBeenCalledWith(false);
  });

  it('switch_sidebar_tab sets the tab and opens the sidebar', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'switch_sidebar_tab', tab: 'sessions' });
    expect(ctx.store.setSidebarActiveTab).toHaveBeenCalledWith('sessions');
    expect(ctx.store.setSidebarOpen).toHaveBeenCalledWith(true);
  });

  it('switch_sidebar_tab works with connections tab', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'switch_sidebar_tab', tab: 'connections' });
    expect(ctx.store.setSidebarActiveTab).toHaveBeenCalledWith('connections');
    expect(ctx.store.setSidebarOpen).toHaveBeenCalledWith(true);
  });
});

// --- Canvas commands ---

describe('executeUiCommand — canvas commands', () => {
  it('open_canvas sets canvas open and content', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, {
      action: 'open_canvas',
      content: { type: 'markdown', content: '# Hello' },
    });
    expect(ctx.store.setCanvasOpen).toHaveBeenCalledWith(true);
    expect(ctx.store.setCanvasContent).toHaveBeenCalledWith({
      type: 'markdown',
      content: '# Hello',
    });
  });

  it('open_canvas with preferredWidth sets the width', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, {
      action: 'open_canvas',
      content: { type: 'markdown', content: '# Hi' },
      preferredWidth: 60,
    });
    expect(ctx.store.setCanvasPreferredWidth).toHaveBeenCalledWith(60);
  });

  it('open_canvas without preferredWidth does not call setCanvasPreferredWidth', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, {
      action: 'open_canvas',
      content: { type: 'markdown', content: '# Hi' },
    });
    expect(ctx.store.setCanvasPreferredWidth).not.toHaveBeenCalled();
  });

  it('update_canvas updates content only', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, {
      action: 'update_canvas',
      content: { type: 'json', data: { key: 'value' } },
    });
    expect(ctx.store.setCanvasContent).toHaveBeenCalledWith({
      type: 'json',
      data: { key: 'value' },
    });
    expect(ctx.store.setCanvasOpen).not.toHaveBeenCalled();
  });

  it('close_canvas calls setCanvasOpen(false)', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'close_canvas' });
    expect(ctx.store.setCanvasOpen).toHaveBeenCalledWith(false);
  });
});

// --- Toast ---

describe('executeUiCommand — show_toast', () => {
  it('calls toast.info for default level', async () => {
    const { toast } = await import('sonner');
    vi.spyOn(toast, 'info');
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'show_toast', message: 'All done', level: 'info' });
    expect(toast.info).toHaveBeenCalledWith('All done', { description: undefined });
  });

  it('calls toast.error for error level', async () => {
    const { toast } = await import('sonner');
    vi.spyOn(toast, 'error');
    const ctx = makeMockCtx();
    executeUiCommand(ctx, {
      action: 'show_toast',
      message: 'Something failed',
      level: 'error',
      description: 'Details here',
    });
    expect(toast.error).toHaveBeenCalledWith('Something failed', { description: 'Details here' });
  });

  it('calls toast.success for success level', async () => {
    const { toast } = await import('sonner');
    vi.spyOn(toast, 'success');
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'show_toast', message: 'Done!', level: 'success' });
    expect(toast.success).toHaveBeenCalledWith('Done!', { description: undefined });
  });

  it('calls toast.warning for warning level', async () => {
    const { toast } = await import('sonner');
    vi.spyOn(toast, 'warning');
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'show_toast', message: 'Watch out', level: 'warning' });
    expect(toast.warning).toHaveBeenCalledWith('Watch out', { description: undefined });
  });
});

// --- Theme ---

describe('executeUiCommand — set_theme', () => {
  it('calls ctx.setTheme with the specified theme', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'set_theme', theme: 'dark' });
    expect(ctx.setTheme).toHaveBeenCalledWith('dark');
  });

  it('calls ctx.setTheme with light', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'set_theme', theme: 'light' });
    expect(ctx.setTheme).toHaveBeenCalledWith('light');
  });
});

// --- Scroll ---

describe('executeUiCommand — scroll_to_message', () => {
  it('calls scrollToMessage with messageId when provided', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'scroll_to_message', messageId: 'msg-42' });
    expect(ctx.scrollToMessage).toHaveBeenCalledWith('msg-42');
  });

  it('calls scrollToMessage with undefined when messageId is omitted', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'scroll_to_message' });
    expect(ctx.scrollToMessage).toHaveBeenCalledWith(undefined);
  });

  it('is a no-op when scrollToMessage is not provided', () => {
    const ctx = makeMockCtx();
    ctx.scrollToMessage = undefined;
    expect(() =>
      executeUiCommand(ctx, { action: 'scroll_to_message', messageId: 'x' })
    ).not.toThrow();
  });
});

// --- Agent switching ---

describe('executeUiCommand — switch_agent', () => {
  it('calls switchAgent with the provided cwd', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'switch_agent', cwd: '/home/user/project' });
    expect(ctx.switchAgent).toHaveBeenCalledWith('/home/user/project');
  });

  it('is a no-op when switchAgent is not provided', () => {
    const ctx = makeMockCtx();
    ctx.switchAgent = undefined;
    expect(() => executeUiCommand(ctx, { action: 'switch_agent', cwd: '/tmp/x' })).not.toThrow();
  });
});

// --- Command palette ---

describe('executeUiCommand — open_command_palette', () => {
  it('calls setGlobalPaletteOpen(true)', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'open_command_palette' });
    expect(ctx.store.setGlobalPaletteOpen).toHaveBeenCalledWith(true);
  });
});
