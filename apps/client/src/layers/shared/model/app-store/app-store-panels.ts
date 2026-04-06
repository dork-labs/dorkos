/**
 * Panels slice — transient dialog and panel open/close state for the app store.
 *
 * None of the fields here are persisted to localStorage; they reset on page refresh.
 *
 * @module shared/model/app-store-panels
 */
import type { StateCreator } from 'zustand';
import type { AppState } from './app-store-types';

// ---------------------------------------------------------------------------
// Tab identifier types
// ---------------------------------------------------------------------------

/** Valid tab identifiers for the Settings dialog. Extension tabs are allowed as arbitrary strings. */
export type SettingsTab =
  | 'appearance'
  | 'preferences'
  | 'statusBar'
  | 'server'
  | 'tools'
  | 'channels'
  | 'agents'
  | 'advanced'
  | (string & {});

/** Valid tab identifiers for the Agent dialog. */
export type AgentDialogTab = 'identity' | 'personality' | 'tools' | 'channels';

// ---------------------------------------------------------------------------
// Slice interface
// ---------------------------------------------------------------------------

export interface PanelsSlice {
  settingsOpen: boolean;
  settingsInitialTab: SettingsTab | null;
  setSettingsOpen: (open: boolean) => void;
  /** Open the Settings dialog pre-navigated to a specific tab. */
  openSettingsToTab: (tab: SettingsTab) => void;

  tasksOpen: boolean;
  setTasksOpen: (open: boolean) => void;
  tasksAgentFilter: string | null;
  setTasksAgentFilter: (id: string | null) => void;
  tasksEditScheduleId: string | null;
  setTasksEditScheduleId: (id: string | null) => void;
  /** Open the Tasks dialog pre-filtered to a specific agent. */
  openTasksForAgent: (agentId: string) => void;
  /** Open the Tasks dialog in edit mode for a specific schedule. */
  openTasksToEdit: (scheduleId: string) => void;

  relayOpen: boolean;
  setRelayOpen: (open: boolean) => void;
  meshOpen: boolean;
  setMeshOpen: (open: boolean) => void;
  restartOverlayOpen: boolean;
  setRestartOverlayOpen: (open: boolean) => void;
  pickerOpen: boolean;
  setPickerOpen: (open: boolean) => void;
  agentDialogOpen: boolean;
  agentDialogInitialTab: AgentDialogTab | null;
  setAgentDialogOpen: (open: boolean) => void;
  /** Open the Agent dialog pre-navigated to a specific tab. */
  openAgentDialogToTab: (tab: AgentDialogTab) => void;

  onboardingStep: number | null;
  setOnboardingStep: (step: number | null) => void;
  /** First message generated during onboarding, used for the magic transition animation. */
  dorkbotFirstMessage: string | null;
  setDorkbotFirstMessage: (msg: string | null) => void;

  globalPaletteOpen: boolean;
  setGlobalPaletteOpen: (open: boolean) => void;
  toggleGlobalPalette: () => void;
  globalPaletteInitialSearch: string | null;
  openGlobalPaletteWithSearch: (text: string) => void;
  clearGlobalPaletteInitialSearch: () => void;

  shortcutsPanelOpen: boolean;
  setShortcutsPanelOpen: (open: boolean) => void;
  toggleShortcutsPanel: () => void;
}

// ---------------------------------------------------------------------------
// Slice creator
// ---------------------------------------------------------------------------

/** Creates the panels slice (all transient dialog/panel open-state). */
export const createPanelsSlice: StateCreator<
  AppState,
  [['zustand/devtools', never]],
  [],
  PanelsSlice
> = (set) => ({
  settingsOpen: false,
  settingsInitialTab: null,
  setSettingsOpen: (open) =>
    set(open ? { settingsOpen: true } : { settingsOpen: false, settingsInitialTab: null }),
  openSettingsToTab: (tab) => set({ settingsOpen: true, settingsInitialTab: tab }),

  tasksOpen: false,
  setTasksOpen: (open) =>
    set(
      open
        ? { tasksOpen: true }
        : { tasksOpen: false, tasksAgentFilter: null, tasksEditScheduleId: null }
    ),
  tasksAgentFilter: null,
  setTasksAgentFilter: (id) => set({ tasksAgentFilter: id }),
  tasksEditScheduleId: null,
  setTasksEditScheduleId: (id) => set({ tasksEditScheduleId: id }),
  openTasksForAgent: (agentId) =>
    set({ tasksOpen: true, tasksAgentFilter: agentId, tasksEditScheduleId: null }),
  openTasksToEdit: (scheduleId) =>
    set({ tasksOpen: true, tasksEditScheduleId: scheduleId, tasksAgentFilter: null }),

  relayOpen: false,
  setRelayOpen: (open) => set({ relayOpen: open }),
  meshOpen: false,
  setMeshOpen: (open) => set({ meshOpen: open }),
  restartOverlayOpen: false,
  setRestartOverlayOpen: (open) => set({ restartOverlayOpen: open }),
  pickerOpen: false,
  setPickerOpen: (open) => set({ pickerOpen: open }),
  agentDialogOpen: false,
  agentDialogInitialTab: null,
  setAgentDialogOpen: (open) =>
    set(open ? { agentDialogOpen: true } : { agentDialogOpen: false, agentDialogInitialTab: null }),
  openAgentDialogToTab: (tab) => set({ agentDialogOpen: true, agentDialogInitialTab: tab }),

  onboardingStep: null,
  setOnboardingStep: (step) => set({ onboardingStep: step }),
  dorkbotFirstMessage: null,
  setDorkbotFirstMessage: (msg) => set({ dorkbotFirstMessage: msg }),

  globalPaletteOpen: false,
  setGlobalPaletteOpen: (open) => set({ globalPaletteOpen: open }),
  toggleGlobalPalette: () => set((s) => ({ globalPaletteOpen: !s.globalPaletteOpen })),
  globalPaletteInitialSearch: null,
  openGlobalPaletteWithSearch: (text) =>
    set({ globalPaletteOpen: true, globalPaletteInitialSearch: text }),
  clearGlobalPaletteInitialSearch: () => set({ globalPaletteInitialSearch: null }),

  shortcutsPanelOpen: false,
  setShortcutsPanelOpen: (open) => set({ shortcutsPanelOpen: open }),
  toggleShortcutsPanel: () => set((s) => ({ shortcutsPanelOpen: !s.shortcutsPanelOpen })),
});
