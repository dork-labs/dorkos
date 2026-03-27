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
  pulseOpen: boolean;
  setPulseOpen: (open: boolean) => void;
  relayOpen: boolean;
  setRelayOpen: (open: boolean) => void;
  meshOpen: boolean;
  setMeshOpen: (open: boolean) => void;
  pickerOpen: boolean;
  setPickerOpen: (open: boolean) => void;

  // Command palette
  setGlobalPaletteOpen: (open: boolean) => void;

  // Canvas
  setCanvasOpen: (open: boolean) => void;
  setCanvasContent: (content: UiCanvasContent | null) => void;
  setCanvasPreferredWidth: (width: number | null) => void;
}

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
      store.setCanvasOpen(true);
      store.setCanvasContent(command.content);
      if (command.preferredWidth != null) {
        store.setCanvasPreferredWidth(command.preferredWidth);
      }
      break;
    case 'update_canvas':
      store.setCanvasContent(command.content);
      break;
    case 'close_canvas':
      store.setCanvasOpen(false);
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
    pulse: store.setPulseOpen,
    relay: store.setRelayOpen,
    mesh: store.setMeshOpen,
    picker: store.setPickerOpen,
  };
  setterMap[panel]?.(open);
}

function togglePanel(store: DispatcherStore, panel: UiPanelId): void {
  const getterMap: Record<UiPanelId, boolean> = {
    settings: store.settingsOpen,
    pulse: store.pulseOpen,
    relay: store.relayOpen,
    mesh: store.meshOpen,
    picker: store.pickerOpen,
  };
  setPanelOpen(store, panel, !getterMap[panel]);
}
