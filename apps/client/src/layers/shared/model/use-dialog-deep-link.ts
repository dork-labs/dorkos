/**
 * Dialog deep-link hooks — bridges global dialog open/tab state to TanStack Router search params.
 *
 * Each hook reads its dialog's URL signal (`?settings=tools`, `?agent=identity&agentPath=...`,
 * `?tasks=open`, etc.) and exposes typed open/close/setTab actions that mirror back to the URL.
 * Used by `RegistryDialog` (open state) and the dialog components themselves (active tab).
 *
 * @module shared/model/use-dialog-deep-link
 */
import { useCallback } from 'react';
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
 * silently landing on nothing. A mapped value can be another tab id (the
 * `channels` → `integrations` migration, DOR-523) or a {@link SettingsRouteTarget}
 * for an id whose destination left the dialog entirely — the capability a
 * future tab deletion needs (DOR-854); no entry uses the route form yet.
 */
const LEGACY_SETTINGS_TAB_MAP: Record<string, SettingsTab | SettingsRouteTarget> = {
  channels: 'integrations',
};

/**
 * Resolve a raw `?settings=` value against a legacy map into a typed target:
 * `null` when there is nothing to resolve (unset or the tabless `open`
 * sentinel), a tab id (migrating retired ids per the map), or a route target
 * for a legacy id that now lives outside the dialog. The map is a parameter
 * so the route branch — dead code against today's production map, which has
 * no route entries — is exercisable directly in tests.
 *
 * @internal Exported for testing only.
 */
export function resolveDeepLinkTarget(
  raw: string | undefined,
  legacyMap: Record<string, SettingsTab | SettingsRouteTarget>
): SettingsDeepLinkTarget | null {
  if (!raw || raw === 'open') return null;
  const legacy = legacyMap[raw];
  if (legacy !== undefined) {
    return typeof legacy === 'string' ? { kind: 'tab', tab: legacy } : legacy;
  }
  return { kind: 'tab', tab: raw as SettingsTab };
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

  // Without a router the URL says nothing, so the store flag is the open signal.
  const isOpen = navigate ? !!search.settings : storeOpen;
  // Route targets are not wired up anywhere yet (no legacy entry maps to one),
  // so this hook only ever surfaces the tab case — `activeTab` stays exactly
  // what `resolveSettingsTab` returned pre-DOR-854 for every id in use today.
  const resolved = navigate ? resolveSettingsDeepLink(search.settings) : null;
  const activeTab = resolved?.kind === 'tab' ? resolved.tab : null;
  const section = navigate ? (search.settingsSection ?? null) : null;

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
    if (!navigate) return setSettingsOpen(false);
    const updater: AnySearchUpdater = (prev) => ({
      ...prev,
      settings: undefined,
      settingsSection: undefined,
    });
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

/** Relay dialog deep-link state and actions. No tabs. */
export function useRelayDeepLink(): DialogDeepLink<never> {
  return useSimpleDialogDeepLink('relay');
}

/** Internal helper for parameterless (no-tab) dialogs. */
function useSimpleDialogDeepLink(paramName: 'tasks' | 'relay'): DialogDeepLink<never> {
  const search = useSafeSearch() as Record<string, string | undefined>;
  const navigate = useSafeNavigate();
  const setStoreOpen = useAppStore((s) =>
    paramName === 'tasks' ? s.setTasksOpen : s.setRelayOpen
  );
  const storeOpen = useAppStore((s) => (paramName === 'tasks' ? s.tasksOpen : s.relayOpen));

  const isOpen = navigate ? !!search[paramName] : storeOpen;

  const open = useCallback(() => {
    if (!navigate) return setStoreOpen(true);
    const updater: AnySearchUpdater = (prev) => ({ ...prev, [paramName]: 'open' });
    navigate({ search: updater as never });
  }, [navigate, paramName, setStoreOpen]);

  const close = useCallback(() => {
    if (!navigate) return setStoreOpen(false);
    const updater: AnySearchUpdater = (prev) => ({ ...prev, [paramName]: undefined });
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
