import { describe, it, expect, vi } from 'vitest';
import { UI_COMMAND_REACH } from '@dorkos/shared/schemas';
import type { UiCommand } from '@dorkos/shared/types';
import {
  executeUiCommand,
  type DispatcherContext,
  type DispatcherStore,
} from '../ui-action-dispatcher';

vi.mock('../celebrations/celebration-effects', () => ({
  fireCelebration: vi.fn().mockResolvedValue(vi.fn()),
}));

// --- Mock store factory ---

function makeMockStore(overrides: Partial<DispatcherStore> = {}): DispatcherStore {
  return {
    setSidebarOpen: vi.fn(),
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
    closeCanvasDocument: vi.fn(),
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

/** A context over a *fixed* mock store. */
function makeMockCtx(storeOverrides: Partial<DispatcherStore> = {}): DispatcherContext {
  const store = makeMockStore(storeOverrides);
  return {
    getStore: () => store,
    setTheme: vi.fn(),
    scrollToMessage: vi.fn(),
    switchAgent: vi.fn(),
    applyShape: vi.fn(),
  };
}

/**
 * A context whose store can be swapped after the context is built — the shape
 * Zustand actually has, where every `set` hands back a NEW state object.
 *
 * @returns The context plus `setStore`, which replaces the state the next
 *   dispatch will read.
 */
function makeLiveCtx(initial: Partial<DispatcherStore> = {}): {
  ctx: DispatcherContext;
  setStore: (overrides: Partial<DispatcherStore>) => DispatcherStore;
} {
  let store = makeMockStore(initial);
  return {
    ctx: {
      getStore: () => store,
      setTheme: vi.fn(),
    },
    setStore: (overrides) => (store = makeMockStore(overrides)),
  };
}

// --- Panel commands ---

describe('executeUiCommand — panel commands', () => {
  it('toggle_panel opens a closed panel', () => {
    const ctx = makeMockCtx({ relayOpen: false });
    executeUiCommand(ctx, { action: 'toggle_panel', panel: 'relay' }, 'agent');
    expect(ctx.getStore().setRelayOpen).toHaveBeenCalledWith(true);
  });

  it('toggle_panel closes an open panel', () => {
    const ctx = makeMockCtx({ relayOpen: true });
    executeUiCommand(ctx, { action: 'toggle_panel', panel: 'relay' }, 'agent');
    expect(ctx.getStore().setRelayOpen).toHaveBeenCalledWith(false);
  });
});

// --- The store a dispatch reads is the store as of the dispatch --- The app entry builds ONE
// `DispatcherContext` at module scope and hands it to every extension for the life of the app.

describe('executeUiCommand — reads the live store, not the one the context was built over', () => {
  // Each of these dispatches TWICE against one context, swapping the state object in between —
  // the real shape, where the app entry's single context is dispatched against for the app's
  // whole life.

  it('toggle_panel reads the flag as of this dispatch, not the last one', () => {
    const { ctx, setStore } = makeLiveCtx({ relayOpen: false });
    const atBoot = ctx.getStore();

    // Boot state: closed. Toggle opens it.
    executeUiCommand(ctx, { action: 'toggle_panel', panel: 'relay' }, 'agent');
    expect(atBoot.setRelayOpen).toHaveBeenCalledWith(true);

    // The panel is open now, and Zustand has replaced the state object.
    const live = setStore({ relayOpen: true });
    executeUiCommand(ctx, { action: 'toggle_panel', panel: 'relay' }, 'agent');

    // Read the live flag → close it.
    expect(live.setRelayOpen).toHaveBeenCalledWith(false);
  });
});

// --- Panels with a URL half (DOR-839) --- Settings and Tasks can be held open by a search param
// as well as the store flag, and `DialogHost` renders them on either.

describe('executeUiCommand — panels with a URL half', () => {
  function makeSignalCtx(urlOpen: Record<string, boolean>, storeOverrides = {}) {
    const close = vi.fn();
    const ctx: DispatcherContext = {
      ...makeMockCtx(storeOverrides),
      panelUrlSignal: { isOpen: (panel) => urlOpen[panel] ?? false, close },
    };
    return { ctx, close };
  }

  it('close_panel clears the URL half as well as the store flag', () => {
    const { ctx, close } = makeSignalCtx({ settings: true });
    executeUiCommand(ctx, { action: 'close_panel', panel: 'settings' }, 'agent');
    expect(ctx.getStore().setSettingsOpen).toHaveBeenCalledWith(false);
    expect(close).toHaveBeenCalledWith('settings');
  });

  it('toggle_panel closes a panel the URL alone is holding open', () => {
    // The store flag says closed, so a store-only read toggles it to open —
    // which does nothing visible, because the URL already has it on screen.
    const { ctx, close } = makeSignalCtx({ settings: true }, { settingsOpen: false });
    executeUiCommand(ctx, { action: 'toggle_panel', panel: 'settings' }, 'agent');
    expect(ctx.getStore().setSettingsOpen).toHaveBeenCalledWith(false);
    expect(close).toHaveBeenCalledWith('settings');
  });
});

// --- Sidebar commands ---

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
    expect(ctx.getStore().openCanvasDocument).toHaveBeenCalledWith({
      type: 'markdown',
      content: '# Hello',
    });
    // Live render path (DOR-97): the canvas only shows when the right panel is open AND its
    // active tab is 'canvas'.
    expect(ctx.getStore().setRightPanelOpen).toHaveBeenCalledWith(true);
    expect(ctx.getStore().setActiveRightPanelTabView).toHaveBeenCalledWith('canvas');
    expect(ctx.getStore().setActiveRightPanelTab).not.toHaveBeenCalled();
    expect(ctx.getStore().setCanvasOpen).toHaveBeenCalledWith(true);
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
    expect(ctx.getStore().updateActiveDocument).toHaveBeenCalledWith({
      type: 'json',
      data: { key: 'value' },
    });
    expect(ctx.getStore().setCanvasOpen).not.toHaveBeenCalled();
  });
});

// --- PIP (floating panel) ---

describe('executeUiCommand — pip commands', () => {
  it('open_pip pops a widget descriptor for the issuing session', () => {
    const ctx = { ...makeMockCtx(), sessionId: 'sess-1' };
    executeUiCommand(ctx, { action: 'open_pip', title: 'Tic-Tac-Toe' }, 'agent');
    expect(ctx.getStore().openPip).toHaveBeenCalledWith({
      kind: 'widget',
      sessionId: 'sess-1',
      title: 'Tic-Tac-Toe',
    });
  });

  it('open_pip without a session degrades to a toast and does not open the panel', async () => {
    const { toast } = await import('sonner');
    vi.spyOn(toast, 'info');
    const ctx = makeMockCtx(); // no sessionId (palette/extension dispatch)
    executeUiCommand(ctx, { action: 'open_pip' }, 'agent');
    expect(ctx.getStore().openPip).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith(
      'Picture-in-picture needs an open chat',
      expect.anything()
    );
  });
});

// --- open_file (client seam for the explorer + agent tool) ---

describe('executeUiCommand — open_file', () => {
  it('resolves a code file to the file viewer and opens + reveals it (agent origin: view-only)', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'open_file', sourcePath: 'src/index.ts' }, 'agent');
    expect(ctx.getStore().openCanvasDocument).toHaveBeenCalledWith({
      type: 'file',
      sourcePath: 'src/index.ts',
    });
    expect(ctx.getStore().setActiveRightPanelTabView).toHaveBeenCalledWith('canvas');
    expect(ctx.getStore().setActiveRightPanelTab).not.toHaveBeenCalled();
    expect(ctx.getStore().setCanvasOpen).toHaveBeenCalledWith(true);
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
      expect(ctx.getStore().openCanvasDocument).toHaveBeenCalledWith(expected);
    }
  });
});

// --- open_diff (DorkOS-observed auto-open + agent tool) ---

describe('executeUiCommand — open_diff', () => {
  it('opens a diff document and reveals the canvas view-only at agent origin (DOR-227)', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'open_diff', sourcePath: 'src/App.tsx' }, 'agent');
    expect(ctx.getStore().openCanvasDocument).toHaveBeenCalledWith({
      type: 'diff',
      sourcePath: 'src/App.tsx',
    });
    // Agent-driven auto-open must not overwrite the user's pinned tab preference.
    expect(ctx.getStore().setActiveRightPanelTabView).toHaveBeenCalledWith('canvas');
    expect(ctx.getStore().setActiveRightPanelTab).not.toHaveBeenCalled();
    expect(ctx.getStore().setCanvasOpen).toHaveBeenCalledWith(true);
  });
});

// --- open_terminal (agent tool → reveal/focus the Terminal tab) ---

describe('executeUiCommand — open_terminal', () => {
  it('agent origin: focuses the Terminal tab view-only, leaving the stored preference untouched', () => {
    // DOR-227: an autonomous `open_terminal` switches what the user sees but
    // must NOT rewrite their per-agent tab preference.
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'open_terminal' }, 'agent');
    expect(ctx.getStore().setRightPanelOpen).toHaveBeenCalledWith(true);
    expect(ctx.getStore().setActiveRightPanelTabView).toHaveBeenCalledWith('terminal');
    expect(ctx.getStore().setActiveRightPanelTab).not.toHaveBeenCalled();
  });

  it('degrades to a toast (no phantom tab) when the transport has no terminal', async () => {
    const { toast } = await import('sonner');
    vi.spyOn(toast, 'info');
    const ctx = makeMockCtx();
    ctx.supportsTerminal = false;
    executeUiCommand(ctx, { action: 'open_terminal' }, 'agent');
    expect(ctx.getStore().setActiveRightPanelTab).not.toHaveBeenCalled();
    expect(ctx.getStore().setActiveRightPanelTabView).not.toHaveBeenCalled();
    expect(ctx.getStore().setRightPanelOpen).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalled();
  });
});

// --- browser_navigate (agent tool → open a browser canvas document) ---

describe('executeUiCommand — browser_navigate', () => {
  it('appends a browser document and reveals the Browser tab', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'browser_navigate', url: 'http://localhost:5173' }, 'agent');
    // Append-and-activate (dedup by URL inside the store) — never clobbers an
    // edited document.
    expect(ctx.getStore().openCanvasDocument).toHaveBeenCalledWith({
      type: 'browser',
      url: 'http://localhost:5173',
    });
    expect(ctx.getStore().setRightPanelOpen).toHaveBeenCalledWith(true);
    // Agent origin → view-only tab switch (DOR-227). A page belongs to the
    // Browser tab, so revealing Canvas would show the reader the wrong strip.
    expect(ctx.getStore().setActiveRightPanelTabView).toHaveBeenCalledWith('browser');
    expect(ctx.getStore().setActiveRightPanelTab).not.toHaveBeenCalled();
    expect(ctx.getStore().setCanvasOpen).toHaveBeenCalledWith(true);
  });
});

// --- The reveal table: which tab a command surfaces (ADR 260911-200304) ---

describe('executeUiCommand — reveal follows what the command produced', () => {
  /** The tab an agent-origin dispatch of `command` switched the panel to. */
  function revealedTab(command: UiCommand): string | undefined {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, command, 'agent');
    const calls = vi.mocked(ctx.getStore().setActiveRightPanelTabView).mock.calls;
    return calls.at(-1)?.[0] ?? undefined;
  }

  it('reveals Browser for an open_canvas carrying a page', () => {
    expect(
      revealedTab({ action: 'open_canvas', content: { type: 'url', url: 'https://a.test/' } })
    ).toBe('browser');
    expect(
      revealedTab({ action: 'open_canvas', content: { type: 'browser', url: 'https://a.test/' } })
    ).toBe('browser');
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
});

// --- Theme ---

// --- Scroll ---

describe('executeUiCommand — scroll_to_message', () => {
  it('calls scrollToMessage with messageId when provided', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'scroll_to_message', messageId: 'msg-42' }, 'agent');
    expect(ctx.scrollToMessage).toHaveBeenCalledWith('msg-42');
  });
});

// --- Agent switching ---

describe('executeUiCommand — switch_agent', () => {
  it('calls switchAgent with the provided cwd', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'switch_agent', cwd: '/home/user/project' }, 'agent');
    expect(ctx.switchAgent).toHaveBeenCalledWith('/home/user/project');
  });
});

// --- Shape switching ---

describe('executeUiCommand — apply_layout', () => {
  it('calls applyShape with the provided shape name', () => {
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'apply_layout', shape: 'linear-ops' }, 'agent');
    expect(ctx.applyShape).toHaveBeenCalledWith('linear-ops');
  });
});

// --- Command palette ---

// --- Celebration ---

describe('executeUiCommand — celebrate', () => {
  it('fires a celebration', async () => {
    const { fireCelebration } = await import('../celebrations/celebration-effects');
    const ctx = makeMockCtx();
    executeUiCommand(ctx, { action: 'celebrate' }, 'agent');
    expect(fireCelebration).toHaveBeenCalled();
  });
});

// --- Reach: which commands leave the browser (DOR-625) ---

/** The other half of the DOR-625 guard, and the half no server test can perform. */
describe('UI_COMMAND_REACH is true of the real dispatcher (DOR-625)', () => {
  /** One real command per action. */
  const SAMPLES: Record<UiCommand['action'], UiCommand> = {
    open_panel: { action: 'open_panel', panel: 'tasks' },
    close_panel: { action: 'close_panel', panel: 'tasks' },
    toggle_panel: { action: 'toggle_panel', panel: 'tasks' },
    open_sidebar: { action: 'open_sidebar' },
    close_sidebar: { action: 'close_sidebar' },
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
          `but the dispatcher answers it by applying a Shape, which writes files and ` +
          `rewrites scheduled work on the operator’s machine. Either the verdict in ` +
          `UI_COMMAND_REACH is wrong or this case body is.`
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
