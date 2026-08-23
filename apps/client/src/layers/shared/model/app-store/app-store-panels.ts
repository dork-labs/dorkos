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
  | 'profile'
  | 'appearance'
  | 'preferences'
  | 'notifications'
  | 'server'
  | 'tools'
  | 'security'
  | 'account'
  | 'runtimes'
  | 'rooms'
  | 'privacy'
  | 'advanced'
  | 'experiments'
  | (string & {});

// ---------------------------------------------------------------------------
// Slice interface
// ---------------------------------------------------------------------------

export interface PanelsSlice {
  /**
   * Settings dialog open flag. Deep-linking to a *tab* is not a store concern —
   * the Settings dialog reads its active tab from `?settings=<tab>`, so callers
   * that want a specific tab use `useSettingsDeepLink().open(tab)`.
   */
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;

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

  /**
   * The profile drawer's store half. Its URL half is `?profile=<member id>`,
   * and `DialogHost` opens the drawer on either — the same dual signal Settings
   * and Tasks carry (DOR-839).
   */
  profileOpen: boolean;
  setProfileOpen: (open: boolean) => void;
  /**
   * Whose profile the drawer is showing, in roster ids.
   *
   * The payload beside the open flag, the same shape `shapeSwitcherFocus` has —
   * and the reason there is a store half at all: the Obsidian embed has no URL
   * to carry the subject in, so without this the drawer would open on nobody.
   * Cleared whenever the drawer closes.
   */
  profileMemberId: string | null;
  /**
   * Which page of that profile is pushed, or `null` for its root — the store
   * half of `?profilePage=`, and the only way the embed can push one at all.
   */
  profilePage: string | null;
  /** Push a page of the open profile, or go back to its root with `null`. */
  setProfilePage: (page: string | null) => void;
  /** Open the drawer on one identity — the only way it opens meaningfully. */
  openProfileForMember: (memberId: string, page?: string) => void;

  relayOpen: boolean;
  setRelayOpen: (open: boolean) => void;
  restartOverlayOpen: boolean;
  setRestartOverlayOpen: (open: boolean) => void;
  pickerOpen: boolean;
  setPickerOpen: (open: boolean) => void;

  /** The Shape switcher dialog — pick/apply an installed Shape (DOR-355). */
  shapeSwitcherOpen: boolean;
  setShapeSwitcherOpen: (open: boolean) => void;
  /**
   * The Shape to highlight when the switcher opens, or `null` for a plain open.
   * Set by the install toast / installed-list "Apply…" affordances so the user
   * lands on the exact Shape they meant, not a generic list. Cleared on close.
   */
  shapeSwitcherFocus: string | null;
  /** Open the switcher with a specific Shape's card highlighted (an Apply affordance). */
  openShapeSwitcherToShape: (name: string) => void;

  /**
   * Session-local suppression of the full-screen onboarding overlay. Set true
   * when the user finishes or skips the flow so the overlay hides immediately
   * (optimistic, ahead of the server config round-trip); reset to false by the
   * "Replay setup" affordance so the flow reopens in the same session. Never
   * persisted — a refresh reverts to the authoritative config signal.
   */
  onboardingHiddenForSession: boolean;
  setOnboardingHiddenForSession: (hidden: boolean) => void;

  /**
   * True once the moments rail has opened its one modal for this page life. Two
   * one-time modals in a single sitting is an interrogation, and the second gets
   * dismissed unread — so the first to open spends the launch.
   *
   * Never persisted, and deliberately not a record of WHICH moment was shown: a
   * reload is a new launch, and every moment's eligibility is a real state field
   * it already owns, so nothing is lost by waiting for the next one.
   */
  momentShownThisLaunch: boolean;
  /** Record that the rail has spent this launch's one moment. One-way. */
  markMomentShown: () => void;

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
  setSettingsOpen: (open) => set({ settingsOpen: open }),

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

  profileOpen: false,
  // Closing drops the subject with it: a drawer that reopened on whoever was in
  // it last would be showing a stale answer to a question nobody asked.
  setProfileOpen: (open) =>
    set(
      open
        ? { profileOpen: true }
        : { profileOpen: false, profileMemberId: null, profilePage: null }
    ),
  profileMemberId: null,
  profilePage: null,
  setProfilePage: (page) => set({ profilePage: page }),
  openProfileForMember: (memberId, page) =>
    set({ profileOpen: true, profileMemberId: memberId, profilePage: page ?? null }),

  relayOpen: false,
  setRelayOpen: (open) => set({ relayOpen: open }),
  restartOverlayOpen: false,
  setRestartOverlayOpen: (open) => set({ restartOverlayOpen: open }),
  pickerOpen: false,
  setPickerOpen: (open) => set({ pickerOpen: open }),
  shapeSwitcherOpen: false,
  setShapeSwitcherOpen: (open) =>
    set(
      open ? { shapeSwitcherOpen: true } : { shapeSwitcherOpen: false, shapeSwitcherFocus: null }
    ),
  shapeSwitcherFocus: null,
  openShapeSwitcherToShape: (name) => set({ shapeSwitcherOpen: true, shapeSwitcherFocus: name }),

  onboardingHiddenForSession: false,
  setOnboardingHiddenForSession: (hidden) => set({ onboardingHiddenForSession: hidden }),

  momentShownThisLaunch: false,
  markMomentShown: () => set({ momentShownThisLaunch: true }),

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
