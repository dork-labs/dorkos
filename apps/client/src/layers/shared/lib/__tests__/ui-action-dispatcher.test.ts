import { describe, it, expect, vi, afterEach } from 'vitest';
import { UI_COMMAND_REACH } from '@dorkos/shared/schemas';
import type { UiCommand } from '@dorkos/shared/types';
import {
  executeUiCommand,
  type DispatcherContext,
  type DispatcherStore,
} from '../ui-action-dispatcher';
import { setPlatformAdapter } from '../platform';

vi.mock('../celebrations/celebration-effects', () => ({
  fireCelebration: vi.fn().mockResolvedValue(vi.fn()),
}));

/** Point `getPlatform()` at an embedded (Obsidian) or standalone-web host. */
function setEmbedded(isEmbedded: boolean) {
  setPlatformAdapter({ isEmbedded, openFile: async () => {} });
}

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
    openPip: vi.fn(),
    closePip: vi.fn(),
    ...overrides,
  };
}

function makeMockCtx(storeOverrides: Partial<DispatcherStore> = {}): DispatcherContext {
  return {
    store: makeMockStore(storeOverrides),
    setTheme: vi.fn(),
    scrollToMessage: vi.fn(),
    switchAgent: vi.fn(),
    applyShape: vi.fn(),
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
  afterEach(() => {
    // Restore the default standalone-web adapter (isEmbedded: false).
    setEmbedded(false);
  });

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

  it('switch_sidebar_tab sets the tab and opens the sidebar on the embedded host', () => {
    setEmbedded(true);
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'switch_sidebar_tab', tab: 'sessions' }, 'agent');
    expect(ctx.store.setSidebarActiveTab).toHaveBeenCalledWith('sessions');
    expect(ctx.store.setSidebarOpen).toHaveBeenCalledWith(true);
  });

  it('switch_sidebar_tab works with the connections tab on the embedded host', () => {
    setEmbedded(true);
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'switch_sidebar_tab', tab: 'connections' }, 'agent');
    expect(ctx.store.setSidebarActiveTab).toHaveBeenCalledWith('connections');
    expect(ctx.store.setSidebarOpen).toHaveBeenCalledWith(true);
  });

  it('switch_sidebar_tab is a no-op on the web cockpit (no sidebar tab strip)', () => {
    setEmbedded(false);
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'switch_sidebar_tab', tab: 'connections' }, 'agent');
    expect(ctx.store.setSidebarActiveTab).not.toHaveBeenCalled();
    expect(ctx.store.setSidebarOpen).not.toHaveBeenCalled();
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

// --- PIP (floating panel) ---

describe('executeUiCommand — pip commands', () => {
  it('open_pip pops a widget descriptor for the issuing session', () => {
    const ctx = { ...makeMockCtx(), sessionId: 'sess-1' };
    executeUiCommand(ctx, { action: 'open_pip', title: 'Tic-Tac-Toe' }, 'agent');
    expect(ctx.store.openPip).toHaveBeenCalledWith({
      kind: 'widget',
      sessionId: 'sess-1',
      title: 'Tic-Tac-Toe',
    });
  });

  it("open_pip falls back to 'Widget' when no title is given", () => {
    const ctx = { ...makeMockCtx(), sessionId: 'sess-1' };
    executeUiCommand(ctx, { action: 'open_pip' }, 'agent');
    expect(ctx.store.openPip).toHaveBeenCalledWith({
      kind: 'widget',
      sessionId: 'sess-1',
      title: 'Widget',
    });
  });

  it('open_pip without a session degrades to a toast and does not open the panel', async () => {
    const { toast } = await import('sonner');
    vi.spyOn(toast, 'info');
    const ctx = makeMockCtx(); // no sessionId (palette/extension dispatch)
    executeUiCommand(ctx, { action: 'open_pip' }, 'agent');
    expect(ctx.store.openPip).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith(
      'Picture-in-picture needs an active session',
      expect.anything()
    );
  });

  it('close_pip closes the floating panel', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'close_pip' }, 'agent');
    expect(ctx.store.closePip).toHaveBeenCalled();
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

  it('resolves media/3D/audio/video/csv extensions to their viewers', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['logo.png', { type: 'image', src: 'logo.png' }],
      ['model.glb', { type: 'model3d', src: 'model.glb' }],
      ['scene.fbx', { type: 'model3d', src: 'scene.fbx' }],
      ['theme.mp3', { type: 'audio', src: 'theme.mp3' }],
      ['demo.mp4', { type: 'video', src: 'demo.mp4' }],
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

// --- open_diff (DorkOS-observed auto-open + agent tool) ---

describe('executeUiCommand — open_diff', () => {
  it('opens a diff document and reveals the canvas view-only at agent origin (DOR-227)', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'open_diff', sourcePath: 'src/App.tsx' }, 'agent');
    expect(ctx.store.openCanvasDocument).toHaveBeenCalledWith({
      type: 'diff',
      sourcePath: 'src/App.tsx',
    });
    // Agent-driven auto-open must not overwrite the user's pinned tab preference.
    expect(ctx.store.setActiveRightPanelTabView).toHaveBeenCalledWith('canvas');
    expect(ctx.store.setActiveRightPanelTab).not.toHaveBeenCalled();
    expect(ctx.store.setCanvasOpen).toHaveBeenCalledWith(true);
  });

  it('persists the tab pick when a user deliberately opens a diff', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'open_diff', sourcePath: 'src/App.tsx' }, 'user');
    expect(ctx.store.setActiveRightPanelTab).toHaveBeenCalledWith('canvas');
    expect(ctx.store.setActiveRightPanelTabView).not.toHaveBeenCalled();
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

// --- Shape switching ---

describe('executeUiCommand — apply_layout', () => {
  it('calls applyShape with the provided shape name', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'apply_layout', shape: 'linear-ops' }, 'agent');
    expect(ctx.applyShape).toHaveBeenCalledWith('linear-ops');
  });

  it('is a no-op when applyShape is not provided (unwired until Phase 3)', () => {
    const ctx = makeMockCtx();
    ctx.applyShape = undefined;
    expect(() =>
      executeUiCommand(ctx, { action: 'apply_layout', shape: 'linear-ops' }, 'agent')
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
  it('fires a celebration', async () => {
    const { fireCelebration } = await import('../celebrations/celebration-effects');
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'celebrate' }, 'agent');
    expect(fireCelebration).toHaveBeenCalled();
  });

  it('threads the command kind, emoji, and the context origin into the celebration', async () => {
    const { fireCelebration } = await import('../celebrations/celebration-effects');
    vi.mocked(fireCelebration).mockClear();
    const ctx = makeMockCtx();
    ctx.celebrationOrigin = { x: 0.25, y: 0.75 };
    executeUiCommand(ctx, { action: 'celebrate', kind: 'emoji', emoji: '🏆' }, 'user');
    expect(fireCelebration).toHaveBeenCalledWith({
      kind: 'emoji',
      emoji: '🏆',
      origin: { x: 0.25, y: 0.75 },
    });
  });

  it('falls back to no origin when the context omits one (agent/stream celebrate)', async () => {
    const { fireCelebration } = await import('../celebrations/celebration-effects');
    vi.mocked(fireCelebration).mockClear();
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'celebrate', kind: 'fireworks' }, 'agent');
    expect(fireCelebration).toHaveBeenCalledWith({
      kind: 'fireworks',
      emoji: undefined,
      origin: undefined,
    });
  });
});

// --- Reach: which commands leave the browser (DOR-625) ---

/**
 * The other half of the DOR-625 guard, and the half no server test can perform.
 *
 * The server decides whether an agent's `control_ui` call needs an approval card
 * by reading `UI_COMMAND_REACH` — a verdict per UI action, `client-only` meaning
 * "this only moves pixels, so do not ask". That verdict is a claim about code in
 * THIS package: the dispatcher below is what actually runs the command, and
 * `apply_layout` is `reaches-the-machine` because the case body calls
 * `ctx.applyShape`, which POSTs `/api/shapes/:name/apply` and arms cron
 * schedules.
 *
 * Nothing connected the claim to the code. `mcp-tool-gate.test.ts` pins that
 * every action HAS a verdict; it says in its own comment that it cannot check
 * whether the verdicts are true, because following `control_ui` → dispatcher →
 * transport → route crosses a package boundary. This test closes that gap from
 * the other side: it drives the real dispatcher with a real command for every
 * action and fails if a `client-only` one reaches a server mutation.
 *
 * ## What it can see
 *
 * `applyShape` is the only `DispatcherContext` callback that mutates server
 * state, and the dispatcher holds no transport of its own — every route call it
 * can cause goes through an injected callback. So spying the callbacks covers
 * every server effect the dispatcher can reach TODAY.
 *
 * ## What it cannot see
 *
 * - A store action that starts calling the server. `DispatcherStore` is Zustand
 *   state today, but nothing forces it to stay that way, and a `setFoo` that
 *   grew a fetch would slip past. The store methods are spies here, so such a
 *   call would be invisible rather than caught.
 * - The dispatcher importing a transport directly instead of taking a callback.
 * - Anything downstream of `applyShapeAction` beyond the POST itself.
 * - Codex. Its `control_ui` events are produced in the server event-mapper and
 *   dispatched through this same function, but its approval gate is the Codex
 *   SDK's and does not consult `UI_COMMAND_REACH` at all.
 */
describe('UI_COMMAND_REACH is true of the real dispatcher (DOR-625)', () => {
  /**
   * One real command per action. Deliberately a total map rather than generated:
   * a generated fixture would drift into passing empty objects the dispatcher
   * short-circuits on, which is a green that proves nothing.
   */
  const SAMPLES: Record<UiCommand['action'], UiCommand> = {
    open_panel: { action: 'open_panel', panel: 'tasks' },
    close_panel: { action: 'close_panel', panel: 'tasks' },
    toggle_panel: { action: 'toggle_panel', panel: 'tasks' },
    open_sidebar: { action: 'open_sidebar' },
    close_sidebar: { action: 'close_sidebar' },
    switch_sidebar_tab: { action: 'switch_sidebar_tab', tab: 'overview' },
    open_canvas: { action: 'open_canvas', content: { type: 'markdown', content: '# hi' } },
    update_canvas: { action: 'update_canvas', content: { type: 'markdown', content: '# hi' } },
    close_canvas: { action: 'close_canvas' },
    open_pip: { action: 'open_pip', title: 'Board' },
    close_pip: { action: 'close_pip' },
    open_file: { action: 'open_file', sourcePath: 'README.md' },
    open_diff: { action: 'open_diff', sourcePath: 'README.md' },
    open_terminal: { action: 'open_terminal' },
    browser_navigate: { action: 'browser_navigate', url: 'http://localhost:3000' },
    show_toast: { action: 'show_toast', message: 'hi', level: 'info' },
    set_theme: { action: 'set_theme', theme: 'dark' },
    scroll_to_message: { action: 'scroll_to_message' },
    switch_agent: { action: 'switch_agent', cwd: '/tmp/project' },
    apply_layout: { action: 'apply_layout', shape: 'linear-ops' },
    open_command_palette: { action: 'open_command_palette' },
    celebrate: { action: 'celebrate' },
  };

  afterEach(() => setEmbedded(false));

  it('covers every action the union declares', () => {
    // Without this the map could silently shrink and every case below would keep
    // passing on a smaller surface.
    expect(Object.keys(SAMPLES).sort()).toEqual(Object.keys(UI_COMMAND_REACH).sort());
  });

  it('no client-only command reaches a server mutation', () => {
    for (const [action, reach] of Object.entries(UI_COMMAND_REACH)) {
      if (reach !== 'client-only') continue;
      const ctx = makeMockCtx();
      executeUiCommand(ctx, SAMPLES[action as UiCommand['action']], 'agent');
      expect(
        ctx.applyShape,
        `${action} is classified client-only, so an agent may issue it with nobody asked — ` +
          `but the dispatcher answers it by applying a Shape, which arms cron schedules on ` +
          `the operator's machine. Either the verdict in UI_COMMAND_REACH is wrong or this ` +
          `case body is.`
      ).not.toHaveBeenCalled();
    }
  });

  it('apply_layout really does reach one, so the guard has a live subject', () => {
    // The other direction. Without it, deleting the `ctx.applyShape` call from the
    // dispatcher would make the check above vacuously green.
    const ctx = makeMockCtx();
    executeUiCommand(ctx, SAMPLES.apply_layout, 'agent');
    expect(ctx.applyShape).toHaveBeenCalledWith('linear-ops');
  });
});
