import { useMemo } from 'react';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import type { Transport } from '@dorkos/shared/transport';
import type { ExtensionPageProps, StatusBarSlotContext } from '@dorkos/extension-api';
import {
  hasPageParams,
  matchExtensionPage,
  parseExtensionPagePath,
  type ExtensionPageMatch,
} from '@/layers/shared/lib/extension-page-path';

// --- Slot ID Constants ---

export const SLOT_IDS = {
  SIDEBAR_FOOTER: 'sidebar.footer',
  SIDEBAR_BODY: 'sidebar.body',
  DASHBOARD_SECTIONS: 'dashboard.sections',
  COMMAND_PALETTE_ITEMS: 'command-palette.items',
  DIALOG: 'dialog',
  SETTINGS_TABS: 'settings.tabs',
  RIGHT_PANEL: 'right-panel',
  SUGGESTION_CHIPS: 'chat.suggestion-chips',
  STATUS_BAR: 'status-bar',
  PAGES: 'pages',
} as const;

export type SlotId = (typeof SLOT_IDS)[keyof typeof SLOT_IDS];

/**
 * The separator `api.registerComponent` puts between an extension's id and its
 * slot-local id when it namespaces a contribution as `${extensionId}:${localId}`.
 */
const EXTENSION_ID_SEPARATOR = ':';

/**
 * True when a contribution id came from an extension rather than from a
 * built-in registration in `app/init-extensions.ts`.
 *
 * The extension API namespaces every contribution it registers as
 * `${extensionId}:${slotLocalId}` (see `extension-api-factory.ts`), and no
 * built-in id contains a colon — the guard test on
 * `isExtensionContributionId` pins that. Testing the separator rather
 * than an allowlist of built-in ids means a new built-in section can never leak
 * into a surface meant for extensions just because someone forgot a list.
 *
 * @param id - A contribution id from any slot.
 */
export function isExtensionContributionId(id: string): boolean {
  return id.includes(EXTENSION_ID_SEPARATOR);
}

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

export interface SidebarBodyContribution extends BaseContribution {
  /**
   * The sidebar body component rendered when this contribution wins the slot.
   * It replaces the app-shell's built-in dashboard/session body wholesale — the
   * surrounding chrome (sidebar trigger, footer, rail, mobile Sheet) is owned by
   * the shell and is never part of the swapped body, so a body contribution
   * renders only its own header + content.
   */
  component: ComponentType;
  /**
   * Predicate against the current route pathname. Return true to take over the
   * sidebar body on that route. Required — unlike other slots' optional
   * `visibleWhen`, a body with no route scope would hijack the sidebar
   * everywhere; the shell defensively treats a contribution that somehow lacks
   * one at runtime as never matching. The highest-priority (lowest number)
   * matching contribution wins; when none match, the shell renders its built-in
   * dashboard/session body.
   */
  visibleWhen: (ctx: { pathname: string }) => boolean;
}

export interface DashboardSectionContribution extends BaseContribution {
  component: ComponentType;
  title?: string;
  /** Return false to hide this section. Evaluated reactively. */
  visibleWhen?: () => boolean;
}

export interface CommandPaletteContribution extends BaseContribution {
  label: string;
  /** Lucide icon name (string, not component). */
  icon: string;
  /** Action identifier dispatched via `usePaletteActions`. */
  action: string;
  shortcut?: string;
  category: 'feature' | 'quick-action';
  /**
   * Extra search terms this entry should match beyond its `label` — aliases,
   * synonyms, or the names of things it subsumes (e.g. an "Integrations"
   * entry matching "connectors", "telegram", "slack"). Fed straight into the
   * palette's fuzzy search alongside the label; omit for entries the label
   * already covers.
   */
  keywords?: string[];
}

export interface DialogContribution extends BaseContribution {
  /** Dialog component accepting `open` and `onOpenChange` props. */
  component: ComponentType<{ open: boolean; onOpenChange: (open: boolean) => void }>;
  /** Key in `useAppStore()` that controls open state (e.g., 'settingsOpen'). */
  openStateKey: string;
  /**
   * URL search-param value identifying this dialog for deep linking
   * (e.g., `?dialog=settings`). Omit for dialogs that should not be
   * addressable via URL.
   */
  urlParam?: 'settings' | 'agent' | 'tasks' | 'relay' | 'mesh' | 'profile';
}

export interface SettingsTabContribution extends BaseContribution {
  label: string;
  icon: LucideIcon;
  component: ComponentType;
  /**
   * Sidebar group this tab sits under in the Settings dialog. Omit to let the
   * dialog file it under "Add-ons", the section reserved for contributed tabs.
   */
  group?: string;
}

/**
 * A client-rendered suggestion chip shown under the latest assistant message on
 * the session surface. A general in-session nudge slot — the living tour's offer
 * chips are its first customer. The component self-gates (renders null when it
 * has nothing to say), so contributing one costs nothing when idle.
 */
export interface SuggestionChipContribution extends BaseContribution {
  component: ComponentType;
}

export interface RightPanelContribution extends BaseContribution {
  /** Display title shown in tooltips and accessibility labels. */
  title: string;
  /**
   * Marks the always-present *global* (spine) tab — the panel's no-selection
   * fallback. The auto-select fallback in {@link RightPanelContainer} prefers the
   * first *contextual* (non-global) visible tab and only lands on a global tab
   * when no contextual tab is visible. So a global tab can sort first in the
   * strip (leftmost) yet never steal the default from a contextual surface — the
   * Chrome sidePanel rule: contextual wins when present, global is the fallback
   * (research: `20260720_context-aware-right-inspector-panels`). Omit (falsy) for
   * ordinary contextual tabs; exactly one built-in tab (Pulse) sets it.
   */
  isGlobal?: boolean;
  /**
   * Tab-strip icon. Optional: extension-contributed tabs register through
   * `api.registerComponent('right-panel', …)`, which lets an author supply an
   * icon but does not require one, so the tab strip falls back to a default (a
   * puzzle-piece) when this is absent. Built-in tabs always set it.
   */
  icon?: LucideIcon;
  /** The panel content component rendered when this tab is active. */
  component: ComponentType;
  /**
   * Optional actions rendered in the shared panel header (left of the close
   * button) while this tab is active — e.g. the Files tab's New file / Refresh
   * toolbar. The container mounts it inside the header it owns, so a
   * contribution can surface header controls without ever rendering (or being
   * able to break) the tab strip itself. Omit for panels with no header
   * controls. Lazy components are supported; the container wraps it in Suspense.
   */
  headerActions?: ComponentType;
  /**
   * `transport`, `agentId`, `cwd`, `explicitAgentPath`, and
   * `isRemoteCommunityRoom` are optional so unit
   * callers can pass a bare `{ pathname }`; the shell (RightPanelContainer)
   * always supplies them. `agentId` and `cwd` are `string | null` — null is the
   * honest value while no agent is registered at the selected folder, no folder
   * is selected, or the lookup hasn't resolved yet.
   *
   * `explicitAgentPath` is the path of an agent the operator *explicitly* opened
   * to inspect this session (via the profile), or null when none has been
   * picked. Unlike `agentId`/`cwd` — which track the ambient working directory
   * the server chose at startup — this is click-driven, so a tab can stay hidden
   * until the user actually selects an agent instead of surfacing an agent they
   * never chose.
   */
  visibleWhen?: (ctx: {
    pathname: string;
    transport?: Transport;
    agentId?: string | null;
    cwd?: string | null;
    explicitAgentPath?: string | null;
    /** Whether the current channel address belongs to a connected community. */
    isRemoteCommunityRoom?: boolean;
  }) => boolean;
}

/**
 * A full page an extension mounted at `/x/<extensionId>/<path>` (spec
 * `flow-multiproject` §6.5). Registered only through `api.registerPage`; the
 * id is `<extensionId>:<path>`, so one extension registering a path twice
 * replaces the first.
 */
export interface ExtensionPageContribution extends BaseContribution {
  /** The extension that registered it. */
  extensionId: string;
  /** The page path as registered: `''` for the home, or segments with `:param`. */
  path: string;
  /** The page itself. */
  component: ComponentType<ExtensionPageProps>;
  /** Title for the page bar, tab, palette and phone menu. */
  title: string;
  /** Icon for the page bar, tab, palette and phone menu. */
  icon?: ComponentType<{ className?: string }>;
  /** Whether it is listed in the palette and the phone "Add-ons" menu. Param paths never are. */
  menu: boolean;
}

/**
 * An item an extension added to the chat status bar (spec `flow-multiproject`
 * §6.6). Core draws every visible one inside the one `extensions` status item,
 * in `priority` order.
 */
export interface StatusBarContribution extends BaseContribution {
  /** The extension that registered it. */
  extensionId: string;
  /** Accessible name of the item's region. */
  label: string;
  /** The item, given the chat's slot context as props. */
  component: ComponentType<StatusBarSlotContext>;
  /** Whether to show it for this chat. Pure; reads only `ctx`. Absent means always. */
  when?: (ctx: StatusBarSlotContext) => boolean;
  /** Whether it needs attention. Pure; reads only `ctx`. Absent means never. */
  urgent?: (ctx: StatusBarSlotContext) => boolean;
}

/**
 * The one kind of mark an extension can put on its own right-panel tab. Core
 * draws it; the extension cannot style it (spec `flow-multiproject` §6.7).
 */
export type TabMarker = 'attention';

// --- Slot Contribution Map ---

/**
 * Maps slot IDs to their contribution types.
 * Declared as an interface (not type) to support `declare module` augmentation in Phase 3.
 */
export interface SlotContributionMap {
  'sidebar.footer': SidebarFooterContribution;
  // First-party only (v1): `sidebar.body` is registered from client init code
  // (`app/init-extensions.ts`), never through the extension-api factory — it is
  // deliberately absent from `ExtensionPointId` in `@dorkos/extension-api`, so
  // `api.registerComponent` cannot target it. Taking over the whole sidebar body
  // is a high-trust surface; exposing it to third-party extensions is a future
  // product decision, not an oversight.
  'sidebar.body': SidebarBodyContribution;
  'dashboard.sections': DashboardSectionContribution;
  'command-palette.items': CommandPaletteContribution;
  dialog: DialogContribution;
  'settings.tabs': SettingsTabContribution;
  'right-panel': RightPanelContribution;
  'chat.suggestion-chips': SuggestionChipContribution;
  'status-bar': StatusBarContribution;
  pages: ExtensionPageContribution;
}

// --- Store ---

interface ExtensionRegistryState {
  /** Internal storage: slot ID -> array of contributions. */
  slots: { [K in SlotId]: SlotContributionMap[K][] };
  /** Register a contribution to a slot. Returns an unsubscribe function. */
  register: <K extends SlotId>(slotId: K, contribution: SlotContributionMap[K]) => () => void;
  /** Get raw (unsorted) contributions for a slot. */
  getContributions: <K extends SlotId>(slotId: K) => SlotContributionMap[K][];
  /**
   * Marks on extension right-panel tabs, keyed by the tab's namespaced
   * contribution id (`<extensionId>:<tabId>`). Absent means unmarked.
   */
  tabMarkers: Readonly<Record<string, TabMarker>>;
  /** Mark a tab, or clear its mark with `null`. No-op when unchanged. */
  setTabMarker: (contributionId: string, marker: TabMarker | null) => void;
  /** Clear every mark an extension set, when it deactivates. */
  clearTabMarkers: (extensionId: string) => void;
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
              // Idempotent: replace any existing entry with the same ID to
              // prevent duplicates from React StrictMode double-mounts or
              // hot-reload races.
              [slotId]: [
                ...state.slots[slotId].filter((c) => c.id !== contribution.id),
                withDefaults,
              ],
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

      tabMarkers: {},

      setTabMarker: (contributionId, marker) => {
        if ((get().tabMarkers[contributionId] ?? null) === marker) return;
        set(
          (state) => {
            const next = { ...state.tabMarkers };
            if (marker === null) delete next[contributionId];
            else next[contributionId] = marker;
            return { tabMarkers: next };
          },
          undefined,
          `tabMarker/${contributionId}`
        );
      },

      clearTabMarkers: (extensionId) => {
        const prefix = `${extensionId}${EXTENSION_ID_SEPARATOR}`;
        const kept = Object.entries(get().tabMarkers).filter(([id]) => !id.startsWith(prefix));
        if (kept.length === Object.keys(get().tabMarkers).length) return;
        set({ tabMarkers: Object.fromEntries(kept) }, undefined, `tabMarkers/clear/${extensionId}`);
      },
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

/**
 * The mark on one right-panel tab, or `null`.
 *
 * @param contributionId - The tab's contribution id.
 */
export function useTabMarker(contributionId: string): TabMarker | null {
  return useExtensionRegistry((state) => state.tabMarkers[contributionId] ?? null);
}

/**
 * The extension pages the command palette and the phone "Add-ons" menu list:
 * every page that asked to be listed and has no `:param` in its path (a page
 * that needs a value cannot be opened from a menu), by title.
 *
 * @param pages - Every registered page.
 */
export function menuExtensionPages(
  pages: readonly ExtensionPageContribution[]
): ExtensionPageContribution[] {
  return pages
    .filter((page) => page.menu && !hasPageParams(page.path))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** The pages {@link menuExtensionPages} lists, kept live from the registry. */
export function useMenuExtensionPages(): ExtensionPageContribution[] {
  const pages = useExtensionRegistry((state) => state.slots.pages);
  return useMemo(() => menuExtensionPages(pages), [pages]);
}

/** An extension page address, and the registered page that answers it (if any). */
export interface ExtensionPageAtPath {
  /** The extension the address belongs to. */
  extensionId: string;
  /** Everything after `/x/<extensionId>/`. */
  subpath: string;
  /** The registered page that answers it, with its param values, or null. */
  match: ExtensionPageMatch<ExtensionPageContribution> | null;
}

/**
 * The extension page at a pathname, kept live from the registry: which
 * extension the address names and which of its pages answers it. Null when the
 * pathname is not an extension page address at all.
 *
 * @param pathname - A router pathname, without query or hash.
 */
export function useExtensionPageAtPath(pathname: string): ExtensionPageAtPath | null {
  const pages = useExtensionRegistry((state) => state.slots.pages);
  return useMemo(() => {
    const parsed = parseExtensionPagePath(pathname);
    if (parsed === null) return null;
    const own = pages.filter((page) => page.extensionId === parsed.extensionId);
    return { ...parsed, match: matchExtensionPage(own, parsed.subpath) };
  }, [pages, pathname]);
}
