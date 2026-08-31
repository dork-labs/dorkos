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
import { useInPlaceNavigate } from './use-in-place-navigate';

// Route-agnostic search updater type used internally. These hooks are
// intentionally generic across routes so TanStack Router can't infer the
// route-specific search type at compile time. Mirrors the pattern in
// `use-filter-state.ts`.
type AnySearchUpdater = (prev: Record<string, unknown>) => Record<string, unknown>;

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
  profile: ['profile', 'profilePage'],
} as const satisfies Record<string, readonly string[]>;

/** A dialog with both a store open flag and a URL open signal. */
export type DualSignalDialog = keyof typeof DIALOG_SEARCH_PARAMS;

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
  const inPlaceNav = useInPlaceNavigate();
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
      if (!inPlaceNav) return setSettingsOpen(true);
      const updater: AnySearchUpdater = (prev) => ({
        ...prev,
        settings: tab ?? 'open',
        settingsSection: sectionId,
      });
      inPlaceNav({ search: updater });
    },
    [inPlaceNav, setSettingsOpen]
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
    if (!inPlaceNav) return;
    const updater: AnySearchUpdater = (prev) => ({ ...prev, ...clearedDialogSearch('settings') });
    inPlaceNav({ search: updater });
  }, [inPlaceNav, setSettingsOpen]);

  const setTab = useCallback(
    (tab: SettingsTab) => {
      if (!inPlaceNav) return;
      const updater: AnySearchUpdater = (prev) => ({
        ...prev,
        settings: tab,
        settingsSection: undefined,
      });
      inPlaceNav({ search: updater, replace: true });
    },
    [inPlaceNav]
  );

  const setSection = useCallback(
    (sectionId: string | null) => {
      if (!inPlaceNav) return;
      const updater: AnySearchUpdater = (prev) => ({
        ...prev,
        settingsSection: sectionId ?? undefined,
      });
      inPlaceNav({ search: updater, replace: true });
    },
    [inPlaceNav]
  );

  return { isOpen, activeTab, section, open, close, setTab, setSection };
}

/** Tasks dialog deep-link state and actions. No tabs. */
export function useTasksDeepLink(): DialogDeepLink<never> {
  return useSimpleDialogDeepLink('tasks');
}

/**
 * What was on screen when a profile opened: the control to hand focus back
 * to, and which root identity it opened — the ONE fact that tells a genuine
 * close of that same open apart from an unrelated one that merely happens to
 * still be pending (DOR-1274, adversarial review).
 */
interface ProfileOpenerCapture {
  /** The control to refocus. */
  node: HTMLElement;
  /**
   * The root identity this capture belongs to — `chain[0] ?? memberId` at
   * capture time, never the leaf of a chain. A chain push does not
   * re-capture (see `open()` below), so this stays the identity the FIRST
   * open in the chain named, and {@link takeProfileOpener} is asked about
   * that same root when the whole chain eventually closes — never about
   * whichever member happened to be on screen at that moment.
   */
  rootMemberId: string;
}

/**
 * The control the profile sheet should hand focus back to once it closes
 * (DOR-1274).
 *
 * A captured NODE, not an id: a profile can be opened from a huge variety of
 * controls — a mention pill, a message face, a hover card's "View profile"
 * footer, a roster card, the sidebar's own face — with no one identifier
 * scheme to look a row back up by the way a room thread panel's origin row
 * can (`widgets/room-view/model/use-restore-thread-focus.ts`). Captured at
 * `open()` time rather than read later
 * off `document.activeElement` by the sheet itself: some of those openers sit
 * inside another overlay (a Radix `HoverCard`) that unmounts the instant its
 * own click handler runs, which is exactly the "menu-close steals the thing
 * it just opened" shape `use-menu-close-focus-guard.ts` names elsewhere — by
 * the time the sheet's `onCloseAutoFocus` runs, that trigger and whatever
 * focus it held are long gone. Module-scoped because the component that calls
 * `open()` and the sheet that consumes this on close are different instances.
 *
 * **Paired with the identity it opened, not read back unconditionally.** A
 * capture that never gets consumed — the docked-link case
 * (`ProfileSheetContainer`'s dock effect, which never mounts a real sheet at
 * all) — used to sit here and hijack whatever UNRELATED close came next,
 * including one with no click behind it at all (a deep link, the browser's
 * back/forward). {@link takeProfileOpener} refuses a mismatched identity, and
 * {@link clearProfileOpener} lets a caller that knows its capture will never
 * be claimed say so up front.
 */
let profileOpener: ProfileOpenerCapture | null = null;

/**
 * Hand back the control a profile was opened from, once — clearing it so a
 * later close with no fresh open before it does not reuse a stale one.
 *
 * @param rootMemberId - The root identity of the sheet that is closing —
 *   `chain[0] ?? memberId`, the same expression `ProfileSheetContainer` builds
 *   its stack from. A capture whose own root does not match this is refused:
 *   it belongs to a DIFFERENT open (docked and never mounted, or superseded by
 *   one that skipped `open()` entirely) and restoring it would hand focus to a
 *   control this close has nothing to do with.
 * @returns The opener, or `null` when nothing was captured for this identity —
 *   no click preceded the open that led here, or the capture on record names
 *   a different root.
 */
export function takeProfileOpener(rootMemberId: string): HTMLElement | null {
  const captured = profileOpener;
  profileOpener = null;
  if (captured === null || captured.rootMemberId !== rootMemberId) return null;
  return captured.node;
}

/**
 * Discard a pending capture that will never be consumed.
 *
 * The docked-link case: `open()` still captures on the way in, but
 * `ProfileSheetContainer` decides to hand the identity to the docked panel
 * instead of ever mounting `ProfileSheet` — so no `onCloseAutoFocus` will ever
 * run to claim it. Left in place, that capture would sit there matching its
 * own root identity's id indefinitely, ready to hijack a LATER, unrelated
 * close that happens to land on the same id by coincidence.
 */
export function clearProfileOpener(): void {
  profileOpener = null;
}

/** The profile's URL state: which identity is open, on which page, and how to change it. */
export interface ProfileDeepLink {
  /** True if the profile should be open. */
  isOpen: boolean;
  /** Whose profile, in roster ids, or `null` when none is open. */
  memberId: string | null;
  /**
   * Which page of that profile is pushed, or `null` for its root.
   *
   * A raw string: the page ids belong to the profile feature, and `shared/`
   * may not import it. The feature parses it and falls back to the root.
   */
  page: string | null;
  /** Open the profile on one identity, optionally straight onto one of its pages. */
  open: (memberId: string, page?: string) => void;
  /** Push a page of the open profile, or go back to its root with `null`. */
  setPage: (page: string | null) => void;
  /** Close the profile. Clears both halves of the signal. */
  close: () => void;
}

/**
 * Profile deep-link state and actions (specs `identity-consistency` §W3.2,
 * `profile-unification` §1.6).
 *
 * The same dual-signal shape as {@link useSettingsDeepLink}, with one
 * difference: the param carries a *subject* rather than a tab, so `?profile=<id>`
 * is a shareable address for one identity and the phone's back gesture closes
 * the profile for free — `open` pushes a history entry rather than replacing one,
 * which is what makes back mean "close this" instead of "leave the page".
 * `?profilePage=` rides alongside it as the page pushed on top, so a page of a
 * profile is an address too.
 *
 * With no router (the Obsidian embed) the store carries the open flag, the
 * subject and the page, so the profile still opens on the right identity — the
 * one thing a store fallback for Settings cannot do, since a tab has no
 * equivalent.
 */
export function useProfileDeepLink(): ProfileDeepLink {
  const search = useSafeSearch() as { profile?: string; profilePage?: string };
  const navigate = useSafeNavigate();
  const inPlaceNav = useInPlaceNavigate();
  const storeMemberId = useAppStore((s) => s.profileMemberId);
  const storePage = useAppStore((s) => s.profilePage);
  const setProfileOpen = useAppStore((s) => s.setProfileOpen);
  const setStorePage = useAppStore((s) => s.setProfilePage);
  const openProfileForMember = useAppStore((s) => s.openProfileForMember);

  const memberId = navigate ? (search.profile ?? null) : storeMemberId;
  const page = navigate ? (search.profilePage ?? null) : storePage;

  const open = useCallback(
    (id: string, toPage?: string) => {
      // Captured before anything else runs — see `takeProfileOpener` (DOR-1274)
      // — but ONLY when nothing is open yet. A chained push (an owner, an
      // agent they manage) calls this same `open()` from a control INSIDE the
      // sheet that is already showing, and that control is what this very
      // call is about to navigate away from — capturing it would hand focus
      // back, on close, to a row that no longer exists (adversarial review
      // fix #2). Skipping the recapture keeps whatever was captured when the
      // sheet was last fully closed, so the whole chain still hands focus
      // back to the control that started it.
      if (memberId === null) {
        profileOpener =
          document.activeElement instanceof HTMLElement
            ? { node: document.activeElement, rootMemberId: id }
            : null;
      }
      if (!inPlaceNav) return openProfileForMember(id, toPage);
      // A history push, not a replace: a chained profile (an owner, an agent
      // they manage) is a place you can come back from, and the phone's back
      // gesture is what people will reach for.
      const updater: AnySearchUpdater = (prev) => ({ ...prev, profile: id, profilePage: toPage });
      inPlaceNav({ search: updater });
    },
    [inPlaceNav, openProfileForMember, memberId]
  );

  const setPage = useCallback(
    (next: string | null) => {
      if (!inPlaceNav) return setStorePage(next);
      const updater: AnySearchUpdater = (prev) => ({ ...prev, profilePage: next ?? undefined });
      // Opening a page pushes, so Back closes the page rather than the profile.
      // Going back to the root REPLACES, so the two directions do not stack up
      // a history of the same profile alternating with itself.
      inPlaceNav({ search: updater, replace: next === null });
    },
    [inPlaceNav, setStorePage]
  );

  const close = useCallback(() => {
    // Both halves, for the same reason the Settings close owns both (DOR-839).
    setProfileOpen(false);
    if (!inPlaceNav) return;
    const updater: AnySearchUpdater = (prev) => ({ ...prev, ...clearedDialogSearch('profile') });
    inPlaceNav({ search: updater });
  }, [inPlaceNav, setProfileOpen]);

  return { isOpen: memberId !== null, memberId, page, open, setPage, close };
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
  const inPlaceNav = useInPlaceNavigate();
  const setStoreOpen = useAppStore((s) => s.setTasksOpen);
  const storeOpen = useAppStore((s) => s.tasksOpen);

  const isOpen = navigate ? !!search[paramName] : storeOpen;

  const open = useCallback(() => {
    if (!inPlaceNav) return setStoreOpen(true);
    const updater: AnySearchUpdater = (prev) => ({ ...prev, [paramName]: 'open' });
    inPlaceNav({ search: updater });
  }, [inPlaceNav, paramName, setStoreOpen]);

  const close = useCallback(() => {
    // Both halves, for the same reason the Settings close owns both (DOR-839).
    setStoreOpen(false);
    if (!inPlaceNav) return;
    const updater: AnySearchUpdater = (prev) => ({ ...prev, ...clearedDialogSearch(paramName) });
    inPlaceNav({ search: updater });
  }, [inPlaceNav, paramName, setStoreOpen]);

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
