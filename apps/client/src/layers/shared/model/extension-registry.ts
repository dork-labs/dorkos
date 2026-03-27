import { useMemo } from 'react';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';

// --- Slot ID Constants ---

export const SLOT_IDS = {
  SIDEBAR_FOOTER: 'sidebar.footer',
  SIDEBAR_TABS: 'sidebar.tabs',
  DASHBOARD_SECTIONS: 'dashboard.sections',
  HEADER_ACTIONS: 'header.actions',
  COMMAND_PALETTE_ITEMS: 'command-palette.items',
  DIALOG: 'dialog',
  SETTINGS_TABS: 'settings.tabs',
  SESSION_CANVAS: 'session.canvas',
} as const;

export type SlotId = (typeof SLOT_IDS)[keyof typeof SLOT_IDS];

// --- Contribution Base ---

/** Base interface for all contributions. */
export interface BaseContribution {
  /** Unique identifier within the slot. */
  id: string;
  /** Sort priority. Lower = higher priority. Default: 50. */
  priority?: number;
}

// --- Per-Slot Contribution Interfaces ---

export interface SidebarFooterContribution extends BaseContribution {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  /** Only show when `import.meta.env.DEV` is true. */
  showInDevOnly?: boolean;
}

export interface SidebarTabContribution extends BaseContribution {
  icon: LucideIcon;
  label: string;
  component: ComponentType;
  /** Return false to hide this tab. Evaluated reactively. */
  visibleWhen?: () => boolean;
  /** Keyboard shortcut label (e.g., "⌘1"). */
  shortcut?: string;
}

export interface DashboardSectionContribution extends BaseContribution {
  component: ComponentType;
  title?: string;
  /** Return false to hide this section. Evaluated reactively. */
  visibleWhen?: () => boolean;
}

export interface HeaderActionContribution extends BaseContribution {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  variant?: 'default' | 'ghost' | 'outline';
}

export interface CommandPaletteContribution extends BaseContribution {
  label: string;
  /** Lucide icon name (string, not component). */
  icon: string;
  /** Action identifier dispatched via `usePaletteActions`. */
  action: string;
  shortcut?: string;
  category: 'feature' | 'quick-action';
}

export interface DialogContribution extends BaseContribution {
  /** Dialog component accepting `open` and `onOpenChange` props. */
  component: ComponentType<{ open: boolean; onOpenChange: (open: boolean) => void }>;
  /** Key in `useAppStore()` that controls open state (e.g., 'settingsOpen'). */
  openStateKey: string;
}

export interface SettingsTabContribution extends BaseContribution {
  label: string;
  icon: LucideIcon;
  component: ComponentType;
}

export interface SessionCanvasContribution extends BaseContribution {
  component: ComponentType;
  /** MIME-like content type this renderer handles. */
  contentType: string;
}

// --- Slot Contribution Map ---

/**
 * Maps slot IDs to their contribution types.
 * Declared as an interface (not type) to support `declare module` augmentation in Phase 3.
 */
export interface SlotContributionMap {
  'sidebar.footer': SidebarFooterContribution;
  'sidebar.tabs': SidebarTabContribution;
  'dashboard.sections': DashboardSectionContribution;
  'header.actions': HeaderActionContribution;
  'command-palette.items': CommandPaletteContribution;
  dialog: DialogContribution;
  'settings.tabs': SettingsTabContribution;
  'session.canvas': SessionCanvasContribution;
}

// --- Store ---

interface ExtensionRegistryState {
  /** Internal storage: slot ID -> array of contributions. */
  slots: { [K in SlotId]: SlotContributionMap[K][] };
  /** Register a contribution to a slot. Returns an unsubscribe function. */
  register: <K extends SlotId>(slotId: K, contribution: SlotContributionMap[K]) => () => void;
  /** Get raw (unsorted) contributions for a slot. */
  getContributions: <K extends SlotId>(slotId: K) => SlotContributionMap[K][];
}

/** Initial state factory -- every slot starts empty. */
export function createInitialSlots(): ExtensionRegistryState['slots'] {
  return Object.values(SLOT_IDS).reduce(
    (acc, id) => ({ ...acc, [id]: [] }),
    {} as ExtensionRegistryState['slots']
  );
}

export const useExtensionRegistry = create<ExtensionRegistryState>()(
  devtools(
    (set, get) => ({
      slots: createInitialSlots(),

      register: (slotId, contribution) => {
        const withDefaults = { priority: 50, ...contribution };

        set(
          (state) => ({
            slots: {
              ...state.slots,
              [slotId]: [...state.slots[slotId], withDefaults],
            },
          }),
          undefined,
          `register/${slotId}/${contribution.id}`
        );

        // Return unsubscribe function
        return () => {
          set(
            (state) => ({
              slots: {
                ...state.slots,
                [slotId]: state.slots[slotId].filter((c) => c.id !== contribution.id),
              },
            }),
            undefined,
            `unregister/${slotId}/${contribution.id}`
          );
        };
      },

      getContributions: (slotId) => get().slots[slotId],
    }),
    { name: 'extension-registry' }
  )
);

// --- Convenience Hook ---

/**
 * Subscribe to a slot and return its contributions sorted by priority.
 * Lower priority number = appears first. Stable sort preserves insertion order for ties.
 *
 * @param slotId - The slot to subscribe to
 */
export function useSlotContributions<K extends SlotId>(slotId: K): SlotContributionMap[K][] {
  // Cast required: TypeScript cannot correlate the mapped-type lookup `slots[K]`
  // back to `SlotContributionMap[K][]` after the generic index access widens the union.
  const contributions = useExtensionRegistry(
    (state) => state.slots[slotId] as SlotContributionMap[K][]
  );

  return useMemo(
    () => [...contributions].sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50)),
    [contributions]
  );
}
