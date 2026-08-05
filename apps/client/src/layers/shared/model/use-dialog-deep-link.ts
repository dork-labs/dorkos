/**
 * Dialog deep-link hooks — bridges global dialog open/tab state to TanStack Router search params.
 *
 * Each hook reads its dialog's URL signal (`?settings=tools`, `?agent=identity&agentPath=...`,
 * `?tasks=open`, etc.) and exposes typed open/close/setTab actions that mirror back to the URL.
 * Used by `RegistryDialog` (open state) and the dialog components themselves (active tab).
 *
 * @module shared/model/use-dialog-deep-link
 */
import { useCallback, useEffect } from 'react';
import type { UiPanelId } from '@dorkos/shared/types';
import { useAppStore } from './app-store';
import type { SettingsTab } from './app-store/app-store-panels';
import { useSafeSearch, useSafeNavigate } from './use-safe-router';

// Route-agnostic search updater type used internally. We cast to this when
// calling navigate without a `to:` — these hooks are intentionally generic
// across routes so TanStack Router can't infer the route-specific search type
// at compile time. Mirrors the pattern in `use-filter-state.ts`.
type AnySearchUpdater = (
  prev: Record<string, string | undefined>
) => Record<string, string | undefined>;

/**
 * Every search param a dual-signal dialog owns — the open signal itself plus any
 * param that only makes sense while it is open (the settings section anchor).
 *
 * A dual-signal dialog is one `DialogHost` renders on `storeOpen || urlIsOpen`,
 * so closing it means clearing *both* halves. This map is the single place that
 * says which params the URL half is made of; every close path builds its patch
 * from {@link clearedDialogSearch} rather than listing params again (DOR-839).
 */
const DIALOG_SEARCH_PARAMS = {
  settings: ['settings', 'settingsSection'],
  tasks: ['tasks'],
} as const satisfies Record<string, readonly string[]>;

/** A dialog with both a store open flag and a URL open signal. */
export type DualSignalDialog = keyof typeof DIALOG_SEARCH_PARAMS;

/**
 * Every search param a dual-signal dialog owns, flattened.
 *
 * Published because these params share one property that matters outside this
 * module: they rewrite the URL **without going anywhere**. Anything deciding
 * whether the cockpit has moved has to read them out first, and it must read
 * them from here rather than keep its own list — a dialog that grows a param
 * would otherwise start reading as a navigation (DOR-928).
 */
export const DIALOG_SEARCH_PARAM_NAMES: readonly string[] =
  Object.values(DIALOG_SEARCH_PARAMS).flat();

/**
 * Build the search patch that clears a dual-signal dialog's URL half.
 *
 * Spread into a search updater (`{ ...prev, ...clearedDialogSearch('settings') }`);
 * TanStack Router drops the `undefined` entries from the resulting URL.
 *
 * @param dialog - Which dialog's params to clear.
 * @returns A patch setting each of the dialog's params to `undefined`.
 */
export function clearedDialogSearch(dialog: DualSignalDialog): Record<string, undefined> {
  return Object.fromEntries(DIALOG_SEARCH_PARAMS[dialog].map((param) => [param, undefined]));
}

/**
 * A legacy `?settings=` id that has moved out of the Settings dialog entirely
 * and now lives at its own route (e.g. a deleted tab that became a page).
 * Distinct from a tab id so a legacy mapping can point at either.
 */
export interface SettingsRouteTarget {
  /** Discriminant. */
  kind: 'route';
  /** App-relative path to navigate to, e.g. `/connections`. */
  path: string;
  /** Optional search params to carry onto the route. */
  search?: Record<string, string | undefined>;
}

/** Where a resolved `?settings=` id points: a dialog tab, or a route. */
export type SettingsDeepLinkTarget = { kind: 'tab'; tab: SettingsTab } | SettingsRouteTarget;

/**
 * Maps a retired `?settings=` id to its current equivalent, so a bookmark or
 * shared link minted before a rename still opens the right place instead of
 * silently landing on nothing. A mapped value can be another tab id, or a
 * {@link SettingsRouteTarget} for an id whose destination left the dialog
 * entirely (the escape hatch DOR-854 built).
 *
 * Both messaging ids now point at the Connections page: `channels` was folded
 * into `integrations` (DOR-523), and `integrations` itself moved out of
 * Settings and onto the page (DOR-857). The Settings tab still exists and is
 * still reachable from inside the dialog until it is deleted; what changes
 * here is where an old *link* lands.
 */
const LEGACY_SETTINGS_TAB_MAP: Record<string, SettingsTab | SettingsRouteTarget> = {
  channels: { kind: 'route', path: '/connections', search: { region: 'messaging' } },
  integrations: { kind: 'route', path: '/connections', search: { region: 'messaging' } },
};

/**
 * Resolve a raw `?settings=` value against a legacy map into a typed target:
 * `null` when there is nothing to resolve (unset or the tabless `open`
 * sentinel), a tab id (migrating retired ids per the map), or a route target
 * for a legacy id that now lives outside the dialog. The map is a parameter so
 * the route branch is exercisable in tests against a map of their own choosing;
 * it stopped being dead code when both messaging ids started pointing at the
 * Connections page (DOR-857).
 *
 * @internal Exported for testing only.
 */
export function resolveDeepLinkTarget(
  raw: string | undefined,
  legacyMap: Record<string, SettingsTab | SettingsRouteTarget>
): SettingsDeepLinkTarget | null {
  if (!raw || raw === 'open') return null;
  // `legacyMap[raw]` alone would also return inherited prototype members —
  // `resolveDeepLinkTarget('constructor', map)` resolves `Object.prototype.constructor`,
  // typed as SettingsDeepLinkTarget but actually a function. Object.hasOwn keeps
  // this to the map's own entries; an id that merely shadows a prototype key
  // (`toString`, `hasOwnProperty`, …) still falls through to the plain-tab case.
  if (Object.hasOwn(legacyMap, raw)) {
    const legacy = legacyMap[raw];
    return typeof legacy === 'string' ? { kind: 'tab', tab: legacy } : legacy;
  }
  return { kind: 'tab', tab: raw };
}

/** Resolve a raw `?settings=` value against the production legacy map. */
function resolveSettingsDeepLink(raw: string | undefined): SettingsDeepLinkTarget | null {
  return resolveDeepLinkTarget(raw, LEGACY_SETTINGS_TAB_MAP);
}

/**
 * What these hooks do when there is no router to navigate — the Obsidian embed
 * renders `App` directly, with no `RouterProvider` (see `use-safe-router.ts`).
 *
 * There is no URL to write, so open/close fall back to the app store's plain
 * open flag. `DialogHost` already opens a dialog on `storeOpen || urlIsOpen`, so
 * the two signals are interchangeable for open/close; only the *tab* is lost,
 * and the dialog lands on its default. That is exactly what these CTAs did
 * before they moved to the URL — a mislabelled destination, not a dead button.
 *
 * The tab-scoped actions (`setTab`, `setSection`) have no store equivalent and
 * no meaning without a URL, so they no-op rather than pretend.
 */

/** Generic shape returned by every dialog deep-link hook. */
export interface DialogDeepLink<T extends string> {
  /** True if the dialog should be open per the URL. */
  isOpen: boolean;
  /** Active tab from the URL (or null if the param is `'open'` / not set). */
  activeTab: T | null;
  /** Sub-section anchor (for intra-tab scroll/expand). */
  section: string | null;
  /** Open the dialog. Pass a tab to deep-link to a specific tab. */
  open: (tab?: T, section?: string) => void;
  /** Close the dialog. Clears all related search params. */
  close: () => void;
  /** Switch active tab without closing. Replaces history entry. */
  setTab: (tab: T) => void;
  /** Set or clear the sub-section anchor. Replaces history entry. */
  setSection: (section: string | null) => void;
}

/** Settings dialog deep-link state and actions. */
export function useSettingsDeepLink(): DialogDeepLink<SettingsTab> {
  const search = useSafeSearch() as { settings?: string; settingsSection?: string };
  const navigate = useSafeNavigate();
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const storeOpen = useAppStore((s) => s.settingsOpen);

  const resolved = navigate ? resolveSettingsDeepLink(search.settings) : null;
  const routeTarget = resolved?.kind === 'route' ? resolved : null;
  // A link whose destination left the dialog should not also flash the dialog
  // open on its way out, so the route case reads as closed here and the effect
  // below sends it on.
  const isOpen = navigate ? !!search.settings && !routeTarget : storeOpen;
  const activeTab = resolved?.kind === 'tab' ? resolved.tab : null;
  const section = navigate ? (search.settingsSection ?? null) : null;

  // Send a retired id to the page that took its job. In an effect rather than
  // at render because navigating is exactly the kind of outside-React work an
  // effect is for, and `replace` keeps the dead link out of history.
  useEffect(() => {
    if (!navigate || !routeTarget) return;
    navigate({
      to: routeTarget.path,
      search: (routeTarget.search ?? {}) as never,
      replace: true,
    });
  }, [navigate, routeTarget]);

  const open = useCallback(
    (tab?: SettingsTab, sectionId?: string) => {
      if (!navigate) return setSettingsOpen(true);
      const updater: AnySearchUpdater = (prev) => ({
        ...prev,
        settings: tab ?? 'open',
        settingsSection: sectionId,
      });
      navigate({ search: updater as never });
    },
    [navigate, setSettingsOpen]
  );

  const close = useCallback(() => {
    // Both halves, every time — this is the only close the dialog has.
    // `DialogHost` renders Settings on `storeOpen || urlIsOpen`, so a close that
    // clears one half leaves the other holding the dialog up. That is exactly
    // what "Replay setup" hit: it cleared the store flag while the toast's
    // `?settings=preferences` link kept the dialog parked over the welcome
    // screen (DOR-839). Clearing an already-false flag is a no-op, so owning
    // both costs nothing on the common path.
    setSettingsOpen(false);
    if (!navigate) return;
    const updater: AnySearchUpdater = (prev) => ({ ...prev, ...clearedDialogSearch('settings') });
    navigate({ search: updater as never });
  }, [navigate, setSettingsOpen]);

  const setTab = useCallback(
    (tab: SettingsTab) => {
      if (!navigate) return;
      const updater: AnySearchUpdater = (prev) => ({
        ...prev,
        settings: tab,
        settingsSection: undefined,
      });
      navigate({ search: updater as never, replace: true });
    },
    [navigate]
  );

  const setSection = useCallback(
    (sectionId: string | null) => {
      if (!navigate) return;
      const updater: AnySearchUpdater = (prev) => ({
        ...prev,
        settingsSection: sectionId ?? undefined,
      });
      navigate({ search: updater as never, replace: true });
    },
    [navigate]
  );

  return { isOpen, activeTab, section, open, close, setTab, setSection };
}

/** Tasks dialog deep-link state and actions. No tabs. */
export function useTasksDeepLink(): DialogDeepLink<never> {
  return useSimpleDialogDeepLink('tasks');
}

/**
 * Whether a dispatcher panel id names one of the dual-signal dialogs — the ones
 * a search param can hold open alongside the store flag.
 *
 * The app entry uses this to build the dispatcher's `panelUrlSignal`: agent UI
 * commands run outside React, so they cannot reach these hooks and need the
 * mapping spelled out (DOR-839). Panels absent from the map (`relay`, `picker`)
 * have no URL half at all.
 *
 * @param panel - A dispatcher panel id.
 * @returns True when the panel has a URL half to read or clear.
 */
export function isDualSignalDialog(panel: UiPanelId): panel is UiPanelId & DualSignalDialog {
  return Object.hasOwn(DIALOG_SEARCH_PARAMS, panel);
}

/**
 * Go to the Connections page, at one of its two halves.
 *
 * Replaces the `?relay=open` dialog hook. The messaging surface is a page now,
 * so "open it" is a navigation, not an open flag — and the region is a scroll
 * target rather than a tab, because both halves are always rendered.
 *
 * With no router (the Obsidian embed) this is a no-op rather than a lie: there
 * is nowhere to navigate to, and the old fallback opened a dialog that no
 * longer exists.
 */
export function useOpenConnections(): (region?: 'messaging' | 'accounts') => void {
  const navigate = useSafeNavigate();
  return useCallback(
    (region?: 'messaging' | 'accounts') => {
      if (!navigate) return;
      navigate({ to: '/connections', search: { region } as never });
    },
    [navigate]
  );
}

/** Internal helper for parameterless (no-tab) dialogs. */
function useSimpleDialogDeepLink(paramName: 'tasks'): DialogDeepLink<never> {
  const search = useSafeSearch() as Record<string, string | undefined>;
  const navigate = useSafeNavigate();
  const setStoreOpen = useAppStore((s) => s.setTasksOpen);
  const storeOpen = useAppStore((s) => s.tasksOpen);

  const isOpen = navigate ? !!search[paramName] : storeOpen;

  const open = useCallback(() => {
    if (!navigate) return setStoreOpen(true);
    const updater: AnySearchUpdater = (prev) => ({ ...prev, [paramName]: 'open' });
    navigate({ search: updater as never });
  }, [navigate, paramName, setStoreOpen]);

  const close = useCallback(() => {
    // Both halves, for the same reason the Settings close owns both (DOR-839).
    setStoreOpen(false);
    if (!navigate) return;
    const updater: AnySearchUpdater = (prev) => ({ ...prev, ...clearedDialogSearch(paramName) });
    navigate({ search: updater as never });
  }, [navigate, paramName, setStoreOpen]);

  return {
    isOpen,
    activeTab: null,
    section: null,
    open,
    close,
    setTab: () => {},
    setSection: () => {},
  };
}
