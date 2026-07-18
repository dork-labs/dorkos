import type { UiCommand, UiCanvasContent, UiPanelId, UiSidebarTab } from '@dorkos/shared/types';
import { resolveViewerForPath, type CanvasViewerType } from '@dorkos/shared/viewer-registry';
import { toast } from 'sonner';
import type { PipContent } from '@/layers/shared/model';
import { fireCelebration, type CelebrationOrigin } from './celebrations/celebration-effects';

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
  /** Persisting tab setter — rewrites the per-agent stored preference (DOR-227). */
  setActiveRightPanelTab: (tabId: string | null) => void;
  /** View-only tab setter — switches the visible tab WITHOUT persisting (DOR-227). */
  setActiveRightPanelTabView: (tabId: string | null) => void;

  // PIP (floating panel)
  /** Pop content into the floating picture-in-picture panel, replacing whatever it shows (DOR-302). */
  openPip: (content: PipContent) => void;
  /** Close the floating picture-in-picture panel. */
  closePip: () => void;
}

/**
 * Who initiated a UI command — decides whether a tab switch persists.
 *
 * The right panel's active tab is a per-agent stored preference (DOR-227) that
 * only an explicit human pick may rewrite. `'user'` dispatches (a click in the
 * file tree, a widget action button) route tab switches through the persisting
 * setter; `'agent'` dispatches (the `control_ui` stream, programmatic extension
 * calls) switch the visible tab view-only, so an agent opening a terminal or
 * canvas never overwrites what the user chose.
 */
export type UiCommandOrigin = 'user' | 'agent';

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
   * Optional: shape switching handler. Given an installed Shape name, applies it
   * (server resolves the manifest + degrades per-piece). Absent until the app
   * shell provides the real implementation (Phase 3, DOR-355 task 3.1) — when
   * absent, `apply_layout` is a safe no-op, matching `switchAgent`.
   */
  applyShape?: (shape: string) => void;
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
  /**
   * Normalized viewport point a `celebrate` command should erupt from — the
   * center of the control the user clicked, so confetti bursts out of the
   * button rather than screen-center. Omitted for agent/stream-initiated
   * celebrates (there is no element), which fall back to a sensible default
   * origin. Ignored by ambient celebration kinds (fireworks/cannons/rain).
   */
  celebrationOrigin?: CelebrationOrigin;
  /**
   * The session that issued an agent stream command. Threaded per-dispatch from
   * the StreamManager's `ui_command` side effect so PIP commands know which
   * session's live widget to pop out. Unset for palette/extension dispatches,
   * which have no originating session — `open_pip` then degrades to a toast.
   */
  sessionId?: string;
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
 * @param origin - Who initiated the command ({@link UiCommandOrigin}); `'user'`
 *   tab switches persist the per-agent preference, `'agent'` ones are view-only.
 *   Required so every call site declares who is asking — silently defaulting is
 *   how an agent overwrites a user preference.
 */
export function executeUiCommand(
  ctx: DispatcherContext,
  command: UiCommand,
  origin: UiCommandOrigin
): void {
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
      revealCanvas(store, origin);
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
      revealCanvas(store, origin);
      break;
    }
    case 'open_diff':
      // Open (or refresh) a diff review for the file as a new canvas document.
      // The store dedups by `diff:<sourcePath>`, so a repeated open — the common
      // case when an agent edits the same file several times — re-activates and
      // refreshes the existing document instead of spawning tabs. The viewer
      // loads baseline + current itself, so no bytes travel here (mirrors
      // `open_file`). `mediaKind` is left unset; the viewer resolves text vs
      // image from the registry.
      store.openCanvasDocument({ type: 'diff', sourcePath: command.sourcePath });
      revealCanvas(store, origin);
      break;
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
      tabSetterFor(store, origin)(TERMINAL_TAB_ID);
      break;
    }
    case 'browser_navigate':
      // Append-and-activate a `browser` canvas document (dedup by URL inside the
      // store), then reveal the canvas. Appending never clobbers a document the
      // user is editing (edit-protection is per-doc; ADR-0292).
      store.openCanvasDocument({ type: 'browser', url: command.url });
      revealCanvas(store, origin);
      break;
    case 'close_canvas':
      store.setCanvasOpen(false);
      store.setRightPanelOpen(false);
      break;

    // --- PIP (floating panel) ---
    case 'open_pip':
      // PIP follows a specific session's live widget fence, so it needs the
      // originating session. Palette/extension dispatches carry none — degrade
      // to a toast rather than popping an empty panel (mirrors open_terminal's
      // graceful degrade). The panel then follows the session's newest
      // `dorkos-ui` fence (LiveSessionWidget), so re-emitting the fence updates
      // it live.
      if (ctx.sessionId === undefined) {
        toast.info('Picture-in-picture needs an active session', {
          description: 'Open a chat session, then pop its widget out.',
        });
        break;
      }
      store.openPip({ kind: 'widget', sessionId: ctx.sessionId, title: command.title ?? 'Widget' });
      break;
    case 'close_pip':
      store.closePip();
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

    // --- Shape ---
    // Minimal exhaustiveness seam: the real app-shell handler (POST
    // /api/shapes/:name/apply + live re-mount) and the switcher UI land in
    // Phase 3 (DOR-355 task 3.1). Optional-context, so unwired it is a safe
    // no-op — mirrors `switch_agent`.
    case 'apply_layout':
      ctx.applyShape?.(command.shape);
      break;

    // --- Command Palette ---
    case 'open_command_palette':
      store.setGlobalPaletteOpen(true);
      break;

    // --- Celebration ---
    case 'celebrate':
      // Fire-and-forget: fireCelebration lazy-loads canvas-confetti and no-ops
      // under prefers-reduced-motion itself, so no extra guard is needed here.
      // The origin (when present) makes the burst erupt from the clicked
      // control; agent/stream celebrates omit it and fall back to a default.
      void fireCelebration({
        kind: command.kind,
        emoji: command.emoji,
        origin: ctx.celebrationOrigin,
      });
      break;

    default: {
      // Exhaustive check — TypeScript errors here if a UiCommand variant is unhandled
      const _exhaustive: never = command;
      console.warn('[UiDispatcher] Unknown action:', (_exhaustive as UiCommand).action);
    }
  }
}

// --- Internal helpers ---

/** Tab setter for an origin: user picks persist the per-agent preference, agent switches are view-only (DOR-227). */
function tabSetterFor(
  store: DispatcherStore,
  origin: UiCommandOrigin
): (tabId: string | null) => void {
  return origin === 'user' ? store.setActiveRightPanelTab : store.setActiveRightPanelTabView;
}

/**
 * Reveal the canvas via its live host: open the right panel and select the
 * canvas tab. `setCanvasOpen` is kept for the legacy AgentCanvas surface.
 * The tab switch respects `origin` — agent-driven reveals do not persist over
 * the user's per-agent tab preference (DOR-227).
 *
 * NOTE: the canvas contribution is only `visibleWhen` pathname === '/session'
 * (init-extensions), so off that route RightPanelContainer's auto-select falls
 * back to the first visible tab — the command still lands (the document is
 * persisted per session) and shows on return to /session.
 */
function revealCanvas(store: DispatcherStore, origin: UiCommandOrigin): void {
  store.setCanvasOpen(true);
  store.setRightPanelOpen(true);
  tabSetterFor(store, origin)(CANVAS_TAB_ID);
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
