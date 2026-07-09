import { describe, it, expect, vi } from 'vitest';
import {
  executeUiCommand,
  type DispatcherContext,
  type DispatcherStore,
} from '../ui-action-dispatcher';

vi.mock('../celebrations/effects', () => ({ fireConfetti: vi.fn().mockResolvedValue(vi.fn()) }));

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
    openCanvasDocument: vi.fn(),
    updateActiveDocument: vi.fn(),
    setCanvasPreferredWidth: vi.fn(),
    setRightPanelOpen: vi.fn(),
    setActiveRightPanelTab: vi.fn(),
    setActiveRightPanelTabView: vi.fn(),
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
    executeUiCommand(ctx, { action: 'open_panel', panel: 'tasks' }, 'agent');
    expect(ctx.store.setTasksOpen).toHaveBeenCalledWith(true);
  });

  it('close_panel calls the correct setter with false', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'close_panel', panel: 'settings' }, 'agent');
    expect(ctx.store.setSettingsOpen).toHaveBeenCalledWith(false);
  });

  it('toggle_panel opens a closed panel', () => {
    const ctx = makeMockCtx({ relayOpen: false });
    executeUiCommand(ctx, { action: 'toggle_panel', panel: 'relay' }, 'agent');
    expect(ctx.store.setRelayOpen).toHaveBeenCalledWith(true);
  });

  it('toggle_panel closes an open panel', () => {
    const ctx = makeMockCtx({ relayOpen: true });
    executeUiCommand(ctx, { action: 'toggle_panel', panel: 'relay' }, 'agent');
    expect(ctx.store.setRelayOpen).toHaveBeenCalledWith(false);
  });

  it('open_panel picker calls setPickerOpen', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'open_panel', panel: 'picker' }, 'agent');
    expect(ctx.store.setPickerOpen).toHaveBeenCalledWith(true);
  });

  it('close_panel settings calls setSettingsOpen with false', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'close_panel', panel: 'settings' }, 'agent');
    expect(ctx.store.setSettingsOpen).toHaveBeenCalledWith(false);
  });
});

// --- Sidebar commands ---

describe('executeUiCommand — sidebar commands', () => {
  it('open_sidebar calls setSidebarOpen(true)', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'open_sidebar' }, 'agent');
    expect(ctx.store.setSidebarOpen).toHaveBeenCalledWith(true);
  });

  it('close_sidebar calls setSidebarOpen(false)', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'close_sidebar' }, 'agent');
    expect(ctx.store.setSidebarOpen).toHaveBeenCalledWith(false);
  });

  it('switch_sidebar_tab sets the tab and opens the sidebar', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'switch_sidebar_tab', tab: 'sessions' }, 'agent');
    expect(ctx.store.setSidebarActiveTab).toHaveBeenCalledWith('sessions');
    expect(ctx.store.setSidebarOpen).toHaveBeenCalledWith(true);
  });

  it('switch_sidebar_tab works with connections tab', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'switch_sidebar_tab', tab: 'connections' }, 'agent');
    expect(ctx.store.setSidebarActiveTab).toHaveBeenCalledWith('connections');
    expect(ctx.store.setSidebarOpen).toHaveBeenCalledWith(true);
  });
});

// --- Canvas commands ---

describe('executeUiCommand — canvas commands', () => {
  it('open_canvas opens a document and reveals the canvas via the right panel', () => {
    const ctx = makeMockCtx();
    executeUiCommand(
      ctx,
      {
        action: 'open_canvas',
        content: { type: 'markdown', content: '# Hello' },
      },
      'agent'
    );
    // Edit-protection is enforced inside openCanvasDocument (per-doc), so the
    // dispatcher unconditionally forwards the content.
    expect(ctx.store.openCanvasDocument).toHaveBeenCalledWith({
      type: 'markdown',
      content: '# Hello',
    });
    // Live render path (DOR-97): the canvas only shows when the right panel is
    // open AND its active tab is 'canvas'. Agent origin → the tab switch is
    // view-only so it never persists over the user's preference (DOR-227).
    expect(ctx.store.setRightPanelOpen).toHaveBeenCalledWith(true);
    expect(ctx.store.setActiveRightPanelTabView).toHaveBeenCalledWith('canvas');
    expect(ctx.store.setActiveRightPanelTab).not.toHaveBeenCalled();
    expect(ctx.store.setCanvasOpen).toHaveBeenCalledWith(true);
  });

  it('open_canvas from a user origin persists the tab pick', () => {
    const ctx = makeMockCtx();
    executeUiCommand(
      ctx,
      { action: 'open_canvas', content: { type: 'markdown', content: '# Hello' } },
      'user'
    );
    expect(ctx.store.setActiveRightPanelTab).toHaveBeenCalledWith('canvas');
    expect(ctx.store.setActiveRightPanelTabView).not.toHaveBeenCalled();
  });

  it('open_canvas with preferredWidth sets the width', () => {
    const ctx = makeMockCtx();
    executeUiCommand(
      ctx,
      {
        action: 'open_canvas',
        content: { type: 'markdown', content: '# Hi' },
        preferredWidth: 60,
      },
      'agent'
    );
    expect(ctx.store.setCanvasPreferredWidth).toHaveBeenCalledWith(60);
  });

  it('open_canvas without preferredWidth does not call setCanvasPreferredWidth', () => {
    const ctx = makeMockCtx();
    executeUiCommand(
      ctx,
      {
        action: 'open_canvas',
        content: { type: 'markdown', content: '# Hi' },
      },
      'agent'
    );
    expect(ctx.store.setCanvasPreferredWidth).not.toHaveBeenCalled();
  });

  it('update_canvas mutates the active document only', () => {
    const ctx = makeMockCtx();
    executeUiCommand(
      ctx,
      {
        action: 'update_canvas',
        content: { type: 'json', data: { key: 'value' } },
      },
      'agent'
    );
    expect(ctx.store.updateActiveDocument).toHaveBeenCalledWith({
      type: 'json',
      data: { key: 'value' },
    });
    expect(ctx.store.setCanvasOpen).not.toHaveBeenCalled();
  });

  it('close_canvas closes the canvas and its right-panel host', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'close_canvas' }, 'agent');
    expect(ctx.store.setCanvasOpen).toHaveBeenCalledWith(false);
    expect(ctx.store.setRightPanelOpen).toHaveBeenCalledWith(false);
  });
});

// --- open_file (client seam for the explorer + agent tool) ---

describe('executeUiCommand — open_file', () => {
  it('resolves a code file to the file viewer and opens + reveals it (agent origin: view-only)', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'open_file', sourcePath: 'src/index.ts' }, 'agent');
    expect(ctx.store.openCanvasDocument).toHaveBeenCalledWith({
      type: 'file',
      sourcePath: 'src/index.ts',
    });
    expect(ctx.store.setActiveRightPanelTabView).toHaveBeenCalledWith('canvas');
    expect(ctx.store.setActiveRightPanelTab).not.toHaveBeenCalled();
    expect(ctx.store.setCanvasOpen).toHaveBeenCalledWith(true);
  });

  it('open_file from the file tree (user origin) persists the tab pick', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'open_file', sourcePath: 'src/index.ts' }, 'user');
    expect(ctx.store.setActiveRightPanelTab).toHaveBeenCalledWith('canvas');
    expect(ctx.store.setActiveRightPanelTabView).not.toHaveBeenCalled();
  });

  it('resolves media/3D/csv extensions to their viewers', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['logo.png', { type: 'image', src: 'logo.png' }],
      ['model.glb', { type: 'model3d', src: 'model.glb' }],
      ['data.csv', { type: 'csv', src: 'data.csv' }],
      ['report.pdf', { type: 'pdf', src: 'report.pdf' }],
      ['notes.md', { type: 'file', sourcePath: 'notes.md', language: 'markdown' }],
    ];
    for (const [path, expected] of cases) {
      const ctx = makeMockCtx();
      executeUiCommand(ctx, { action: 'open_file', sourcePath: path }, 'agent');
      expect(ctx.store.openCanvasDocument).toHaveBeenCalledWith(expected);
    }
  });

  it('honors a config viewer override', () => {
    const ctx = makeMockCtx();
    ctx.workbenchViewerOverrides = { csv: 'file' };
    executeUiCommand(ctx, { action: 'open_file', sourcePath: 'data.csv' }, 'agent');
    expect(ctx.store.openCanvasDocument).toHaveBeenCalledWith({
      type: 'file',
      sourcePath: 'data.csv',
    });
  });
});

// --- open_terminal (agent tool → reveal/focus the Terminal tab) ---

describe('executeUiCommand — open_terminal', () => {
  it('agent origin: focuses the Terminal tab view-only, leaving the stored preference untouched', () => {
    // DOR-227: an autonomous `open_terminal` switches what the user sees but
    // must NOT rewrite their per-agent tab preference.
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'open_terminal' }, 'agent');
    expect(ctx.store.setRightPanelOpen).toHaveBeenCalledWith(true);
    expect(ctx.store.setActiveRightPanelTabView).toHaveBeenCalledWith('terminal');
    expect(ctx.store.setActiveRightPanelTab).not.toHaveBeenCalled();
  });

  it('user origin: focusing the Terminal tab persists the preference', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'open_terminal' }, 'user');
    expect(ctx.store.setRightPanelOpen).toHaveBeenCalledWith(true);
    expect(ctx.store.setActiveRightPanelTab).toHaveBeenCalledWith('terminal');
    expect(ctx.store.setActiveRightPanelTabView).not.toHaveBeenCalled();
  });

  it('ignores the advisory cwd hint (PTY spawns in the session worktree)', () => {
    // No agent-side PTY spawn: the command only reveals the tab, so cwd never
    // reaches the store.
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'open_terminal', cwd: '/somewhere/else' }, 'agent');
    expect(ctx.store.setActiveRightPanelTabView).toHaveBeenCalledWith('terminal');
  });

  it('degrades to a toast (no phantom tab) when the transport has no terminal', async () => {
    // DirectTransport/Obsidian: the Terminal tab does not exist, so gate on
    // supportsTerminal:false and surface a graceful toast instead of focusing it.
    const { toast } = await import('sonner');
    vi.spyOn(toast, 'info');
    const ctx = makeMockCtx();
    ctx.supportsTerminal = false;
    executeUiCommand(ctx, { action: 'open_terminal' }, 'agent');
    expect(ctx.store.setActiveRightPanelTab).not.toHaveBeenCalled();
    expect(ctx.store.setActiveRightPanelTabView).not.toHaveBeenCalled();
    expect(ctx.store.setRightPanelOpen).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalled();
  });
});

// --- browser_navigate (agent tool → open a browser canvas document) ---

describe('executeUiCommand — browser_navigate', () => {
  it('appends a browser document and reveals the canvas', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'browser_navigate', url: 'http://localhost:5173' }, 'agent');
    // Append-and-activate (dedup by URL inside the store) — never clobbers an
    // edited document.
    expect(ctx.store.openCanvasDocument).toHaveBeenCalledWith({
      type: 'browser',
      url: 'http://localhost:5173',
    });
    expect(ctx.store.setRightPanelOpen).toHaveBeenCalledWith(true);
    // Agent origin → view-only tab switch (DOR-227).
    expect(ctx.store.setActiveRightPanelTabView).toHaveBeenCalledWith('canvas');
    expect(ctx.store.setActiveRightPanelTab).not.toHaveBeenCalled();
    expect(ctx.store.setCanvasOpen).toHaveBeenCalledWith(true);
  });
});

// --- Toast ---

describe('executeUiCommand — show_toast', () => {
  it('calls toast.info for default level', async () => {
    const { toast } = await import('sonner');
    vi.spyOn(toast, 'info');
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'show_toast', message: 'All done', level: 'info' }, 'agent');
    expect(toast.info).toHaveBeenCalledWith('All done', { description: undefined });
  });

  it('calls toast.error for error level', async () => {
    const { toast } = await import('sonner');
    vi.spyOn(toast, 'error');
    const ctx = makeMockCtx();
    executeUiCommand(
      ctx,
      {
        action: 'show_toast',
        message: 'Something failed',
        level: 'error',
        description: 'Details here',
      },
      'agent'
    );
    expect(toast.error).toHaveBeenCalledWith('Something failed', { description: 'Details here' });
  });

  it('calls toast.success for success level', async () => {
    const { toast } = await import('sonner');
    vi.spyOn(toast, 'success');
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'show_toast', message: 'Done!', level: 'success' }, 'agent');
    expect(toast.success).toHaveBeenCalledWith('Done!', { description: undefined });
  });

  it('calls toast.warning for warning level', async () => {
    const { toast } = await import('sonner');
    vi.spyOn(toast, 'warning');
    const ctx = makeMockCtx();
    executeUiCommand(
      ctx,
      { action: 'show_toast', message: 'Watch out', level: 'warning' },
      'agent'
    );
    expect(toast.warning).toHaveBeenCalledWith('Watch out', { description: undefined });
  });
});

// --- Theme ---

describe('executeUiCommand — set_theme', () => {
  it('calls ctx.setTheme with the specified theme', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'set_theme', theme: 'dark' }, 'agent');
    expect(ctx.setTheme).toHaveBeenCalledWith('dark');
  });

  it('calls ctx.setTheme with light', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'set_theme', theme: 'light' }, 'agent');
    expect(ctx.setTheme).toHaveBeenCalledWith('light');
  });
});

// --- Scroll ---

describe('executeUiCommand — scroll_to_message', () => {
  it('calls scrollToMessage with messageId when provided', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'scroll_to_message', messageId: 'msg-42' }, 'agent');
    expect(ctx.scrollToMessage).toHaveBeenCalledWith('msg-42');
  });

  it('calls scrollToMessage with undefined when messageId is omitted', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'scroll_to_message' }, 'agent');
    expect(ctx.scrollToMessage).toHaveBeenCalledWith(undefined);
  });

  it('is a no-op when scrollToMessage is not provided', () => {
    const ctx = makeMockCtx();
    ctx.scrollToMessage = undefined;
    expect(() =>
      executeUiCommand(ctx, { action: 'scroll_to_message', messageId: 'x' }, 'agent')
    ).not.toThrow();
  });
});

// --- Agent switching ---

describe('executeUiCommand — switch_agent', () => {
  it('calls switchAgent with the provided cwd', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'switch_agent', cwd: '/home/user/project' }, 'agent');
    expect(ctx.switchAgent).toHaveBeenCalledWith('/home/user/project');
  });

  it('is a no-op when switchAgent is not provided', () => {
    const ctx = makeMockCtx();
    ctx.switchAgent = undefined;
    expect(() =>
      executeUiCommand(ctx, { action: 'switch_agent', cwd: '/tmp/x' }, 'agent')
    ).not.toThrow();
  });
});

// --- Command palette ---

describe('executeUiCommand — open_command_palette', () => {
  it('calls setGlobalPaletteOpen(true)', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'open_command_palette' }, 'agent');
    expect(ctx.store.setGlobalPaletteOpen).toHaveBeenCalledWith(true);
  });
});

// --- Celebration ---

describe('executeUiCommand — celebrate', () => {
  it('fires confetti', async () => {
    const { fireConfetti } = await import('../celebrations/effects');
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'celebrate' }, 'agent');
    expect(fireConfetti).toHaveBeenCalled();
  });
});
