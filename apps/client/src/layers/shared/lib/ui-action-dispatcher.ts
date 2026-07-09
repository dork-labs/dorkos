import type { UiCommand, UiCanvasContent, UiPanelId, UiSidebarTab } from '@dorkos/shared/types';
import { resolveViewerForPath, type CanvasViewerType } from '@dorkos/shared/viewer-registry';
import { toast } from 'sonner';

/**
 * Minimal store interface the dispatcher requires.
 *
 * Declared as a structural subset so it compiles against the current
 * `useAppStore` state and is forward-compatible when canvas fields
 * (task 5.1) and sidebar-tab extensions are added.
 */
export interface DispatcherStore {
  // Sidebar
  setSidebarOpen: (open: boolean) => void;
  setSidebarActiveTab: (tab: UiSidebarTab) => void;

  // Panels
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  tasksOpen: boolean;
  setTasksOpen: (open: boolean) => void;
  relayOpen: boolean;
  setRelayOpen: (open: boolean) => void;
  pickerOpen: boolean;
  setPickerOpen: (open: boolean) => void;

  // Command palette
  setGlobalPaletteOpen: (open: boolean) => void;

  // Canvas (multi-document)
  setCanvasOpen: (open: boolean) => void;
  /**
   * Append a document for `content` and activate it (dedup-by-source). Edit-
   * protection is enforced inside the store action: a re-activated document that
   * is being edited keeps its content (ADR-0292).
   */
  openCanvasDocument: (content: UiCanvasContent) => void;
  /**
   * Mutate the active document's content. A no-op while that document is being
   * edited, so the in-canvas editor stays the sole writer (ADR-0292).
   */
  updateActiveDocument: (content: UiCanvasContent) => void;
  setCanvasPreferredWidth: (width: number | null) => void;

  // Right panel — the live host for the canvas contribution. The canvas only
  // renders when the right panel is open AND its active tab is 'canvas'
  // (RightPanelContainer), so agent-driven open/close must drive this state,
  // not just the legacy `canvasOpen` flag (DOR-97).
  setRightPanelOpen: (open: boolean) => void;
  setActiveRightPanelTab: (tabId: string | null) => void;
}

/** Right-panel tab id the canvas contribution registers under (init-extensions). */
const CANVAS_TAB_ID = 'canvas';

/** Right-panel tab id the terminal contribution registers under (init-extensions). */
const TERMINAL_TAB_ID = 'terminal';

/** Dependencies injected by the caller. All are obtainable outside React. */
export interface DispatcherContext {
  /** useAppStore.getState() — the raw Zustand state object */
  store: DispatcherStore;
  /** Theme setter (from useTheme or stored ref) */
  setTheme: (theme: 'light' | 'dark') => void;
  /** Optional: scroll-to-message handler */
  scrollToMessage?: (messageId?: string) => void;
  /** Optional: agent switching handler */
  switchAgent?: (cwd: string) => void;
  /**
   * Optional extension → viewer overrides (config `workbench.defaultViewers`)
   * consulted when resolving an `open_file` command's viewer. Omit to use only
   * the built-in registry defaults.
   */
  workbenchViewerOverrides?: Record<string, string>;
  /**
   * Whether the active transport can host a server-side terminal
   * (`transport.supportsTerminal`). Consulted by `open_terminal`: when `false`
   * the action surfaces a toast instead of revealing an unavailable tab (the
   * Terminal contribution is hidden under DirectTransport/Obsidian). Omit to
   * treat the terminal as available (the web default).
   */
  supportsTerminal?: boolean;
}

/**
 * Execute a UI command issued by an agent or the command palette.
 *
 * Pure side-effect dispatcher — no return value, no async, no React
 * dependencies. Callable from stream event handlers, keyboard shortcuts,
 * and command palette actions with equal safety.
 *
 * @param ctx - Injected dependencies (store snapshot, theme setter, optional handlers)
 * @param command - Validated `UiCommand` discriminated union value
 */
export function executeUiCommand(ctx: DispatcherContext, command: UiCommand): void {
  const { store } = ctx;

  switch (command.action) {
    // --- Panels ---
    case 'open_panel':
      setPanelOpen(store, command.panel, true);
      break;
    case 'close_panel':
      setPanelOpen(store, command.panel, false);
      break;
    case 'toggle_panel':
      togglePanel(store, command.panel);
      break;

    // --- Sidebar ---
    case 'open_sidebar':
      store.setSidebarOpen(true);
      break;
    case 'close_sidebar':
      store.setSidebarOpen(false);
      break;
    case 'switch_sidebar_tab':
      store.setSidebarActiveTab(command.tab);
      store.setSidebarOpen(true);
      break;

    // --- Canvas (multi-document) ---
    case 'open_canvas':
      // Edit-protection (ADR-0292) is enforced inside `openCanvasDocument`: a
      // re-activated document that is being edited keeps its content. The
      // panel-reveal side effects below run regardless so the canvas surfaces.
      if (command.content != null) {
        store.openCanvasDocument(command.content);
      }
      if (command.preferredWidth != null) {
        store.setCanvasPreferredWidth(command.preferredWidth);
      }
      revealCanvas(store);
      break;
    case 'update_canvas':
      // `updateActiveDocument` ignores the push while the active document is
      // being edited (ADR-0292); the editor stays the sole writer.
      store.updateActiveDocument(command.content);
      break;
    case 'open_file': {
      // Resolve the viewer from the mime→viewer registry and open the file as a
      // new canvas document. Local paths in the built content are resolved to
      // cwd-confined URLs by the renderers at render time, so no cwd is needed
      // here. This is the client seam the file explorer and the agent's
      // `open_file` tool both drive.
      const viewer = resolveViewerForPath(command.sourcePath, ctx.workbenchViewerOverrides);
      store.openCanvasDocument(buildOpenFileContent(viewer, command.sourcePath));
      revealCanvas(store);
      break;
    }
    case 'open_terminal': {
      // No agent-side PTY spawn (PTY creation is client-driven): reveal and
      // focus the Terminal tab for the attached session, which spawns the shell
      // in the session's own worktree — so the command's `cwd` hint is advisory
      // and unused here. Web-only: under a transport without terminal support
      // (DirectTransport/Obsidian) the tab does not exist, so degrade to a toast
      // rather than focusing a phantom tab.
      if (ctx.supportsTerminal === false) {
        toast.info('Terminal is not available here', {
          description: 'Open this session in the DorkOS web app to use the terminal.',
        });
        break;
      }
      store.setRightPanelOpen(true);
      store.setActiveRightPanelTab(TERMINAL_TAB_ID);
      break;
    }
    case 'browser_navigate':
      // Append-and-activate a `browser` canvas document (dedup by URL inside the
      // store), then reveal the canvas. Appending never clobbers a document the
      // user is editing (edit-protection is per-doc; ADR-0292).
      store.openCanvasDocument({ type: 'browser', url: command.url });
      revealCanvas(store);
      break;
    case 'close_canvas':
      store.setCanvasOpen(false);
      store.setRightPanelOpen(false);
      break;

    // --- Toast ---
    case 'show_toast':
      toast[command.level](command.message, {
        description: command.description,
      });
      break;

    // --- Theme ---
    case 'set_theme':
      ctx.setTheme(command.theme);
      break;

    // --- Scroll ---
    case 'scroll_to_message':
      ctx.scrollToMessage?.(command.messageId);
      break;

    // --- Agent ---
    case 'switch_agent':
      ctx.switchAgent?.(command.cwd);
      break;

    // --- Command Palette ---
    case 'open_command_palette':
      store.setGlobalPaletteOpen(true);
      break;

    default: {
      // Exhaustive check — TypeScript errors here if a UiCommand variant is unhandled
      const _exhaustive: never = command;
      console.warn('[UiDispatcher] Unknown action:', (_exhaustive as UiCommand).action);
    }
  }
}

// --- Internal helpers ---

/**
 * Reveal the canvas via its live host: open the right panel and select the
 * canvas tab. `setCanvasOpen` is kept for the legacy AgentCanvas surface.
 *
 * NOTE: the canvas contribution is only `visibleWhen` pathname === '/session'
 * (init-extensions), so off that route RightPanelContainer's auto-select falls
 * back to the first visible tab — the command still lands (the document is
 * persisted per session) and shows on return to /session.
 */
function revealCanvas(store: DispatcherStore): void {
  store.setCanvasOpen(true);
  store.setRightPanelOpen(true);
  store.setActiveRightPanelTab(CANVAS_TAB_ID);
}

/** Build the canvas content for an `open_file` command from its resolved viewer. */
function buildOpenFileContent(viewer: CanvasViewerType, sourcePath: string): UiCanvasContent {
  switch (viewer) {
    case 'image':
      return { type: 'image', src: sourcePath };
    case 'pdf':
      return { type: 'pdf', src: sourcePath };
    case 'model3d':
      return { type: 'model3d', src: sourcePath };
    case 'csv':
      return { type: 'csv', src: sourcePath };
    case 'markdown':
      // Rendered by the file viewer, which loads the bytes and routes markdown
      // to the rich Blintz editor (the `language` hint flags it).
      return { type: 'file', sourcePath, language: 'markdown' };
    case 'file':
      return { type: 'file', sourcePath };
  }
}

function setPanelOpen(store: DispatcherStore, panel: UiPanelId, open: boolean): void {
  const setterMap: Record<UiPanelId, (open: boolean) => void> = {
    settings: store.setSettingsOpen,
    tasks: store.setTasksOpen,
    relay: store.setRelayOpen,
    picker: store.setPickerOpen,
  };
  setterMap[panel]?.(open);
}

function togglePanel(store: DispatcherStore, panel: UiPanelId): void {
  const getterMap: Record<UiPanelId, boolean> = {
    settings: store.settingsOpen,
    tasks: store.tasksOpen,
    relay: store.relayOpen,
    picker: store.pickerOpen,
  };
  setPanelOpen(store, panel, !getterMap[panel]);
}
