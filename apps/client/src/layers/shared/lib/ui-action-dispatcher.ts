import type { UiCommand, UiCanvasContent, UiPanelId, UiSidebarTab } from '@dorkos/shared/types';
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

  // Canvas
  setCanvasOpen: (open: boolean) => void;
  setCanvasContent: (content: UiCanvasContent | null) => void;
  setCanvasPreferredWidth: (width: number | null) => void;
  /**
   * True while the user is editing the markdown canvas. When set, agent content
   * pushes (open_canvas / update_canvas) are skipped so the editor's save wins
   * ("protect the edit", ADR-0292).
   */
  canvasEditing: boolean;

  // Right panel — the live host for the canvas contribution. The canvas only
  // renders when the right panel is open AND its active tab is 'canvas'
  // (RightPanelContainer), so agent-driven open/close must drive this state,
  // not just the legacy `canvasOpen` flag (DOR-97).
  setRightPanelOpen: (open: boolean) => void;
  setActiveRightPanelTab: (tabId: string | null) => void;
}

/** Right-panel tab id the canvas contribution registers under (init-extensions). */
const CANVAS_TAB_ID = 'canvas';

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

    // --- Canvas ---
    case 'open_canvas':
      // Protect the edit (ADR-0292): while the user is editing the markdown
      // canvas, the agent's content push is skipped — the editor is the sole
      // writer. The panel-reveal side effects below still run so the canvas
      // surfaces either way.
      if (command.content != null && !store.canvasEditing) {
        store.setCanvasContent(command.content);
      }
      if (command.preferredWidth != null) {
        store.setCanvasPreferredWidth(command.preferredWidth);
      }
      // Reveal the canvas via its live host: open the right panel and select the
      // canvas tab. `setCanvasOpen` is kept for the legacy AgentCanvas surface.
      // NOTE: the canvas contribution is only `visibleWhen` pathname === '/session'
      // (init-extensions), so off that route RightPanelContainer's auto-select
      // falls back to the first visible tab (Agent Hub) — the command still lands
      // (canvasContent is set, persisted per session) and shows on return to /session.
      store.setCanvasOpen(true);
      store.setRightPanelOpen(true);
      store.setActiveRightPanelTab(CANVAS_TAB_ID);
      break;
    case 'update_canvas':
      // Protect the edit (ADR-0292): ignore the agent's content push while the
      // user is editing the markdown canvas.
      if (!store.canvasEditing) {
        store.setCanvasContent(command.content);
      }
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
