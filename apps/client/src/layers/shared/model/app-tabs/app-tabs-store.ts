/**
 * The cockpit's in-window tabs (DOR-540).
 *
 * A tab is one **location** — a router-relative `path?search#hash`. That is the
 * whole model, and it is deliberately thin: the URL stays the single address of
 * what you are looking at, so every deep link (`dorkos://`, a bookmark, the
 * `/session` loader's auto-select redirect) keeps working untouched, and the tab
 * set is a per-window list of remembered locations layered on top.
 *
 * **The URL is the active tab.** One reconciliation rule keeps the two in step,
 * applied on every router location change ({@link AppTabsState.syncLocation}):
 *
 * 1. The active tab already sits at this location → nothing to do.
 * 2. Another tab sits at exactly this location → that tab becomes active.
 * 3. Otherwise the active tab **adopts** the location, exactly like navigating
 *    inside a browser tab changes what that tab holds.
 * 4. No tabs at all (first paint) → mint one for wherever we landed.
 *
 * That rule is what makes Back/Forward coherent instead of accidental. Switching
 * tabs navigates, so it pushes a history entry; Back returns to the previous
 * tab's location, rule 2 re-activates that tab, and you are back where you were.
 * Navigating **within** a tab rewrites that tab's href (rule 3), so Back rewinds
 * the tab's own content rather than teleporting between tabs. No tab state is
 * ever written into the URL — a link you copy addresses a session, never a
 * window layout.
 *
 * **Only the active tab holds a session stream.** Background tabs are inert
 * href records: `StreamManager` attaches exactly one foreground session (plus an
 * optional PIP pin), and activating a tab re-attaches it, rehydrating from the
 * durable stream's snapshot-plus-replay. Background tabs still look alive
 * because their badge reads the global session-list stream, which fans out
 * lifecycle events for every session whether this client is attached or not.
 * Opening ten tabs therefore opens no extra connections.
 *
 * Persisted to `sessionStorage`, which is scoped per browser tab / per Electron
 * renderer: a reload restores your tabs, and a second DorkOS window gets its own
 * set instead of fighting over one.
 *
 * @module shared/model/app-tabs/app-tabs-store
 */
import { create } from 'zustand';
import { classifyLink } from '../../lib/link-navigation';

/** One tab: a stable client id and the location it holds. */
export interface AppTab {
  /** Stable client-side id. Never leaves the renderer. */
  id: string;
  /** Router-relative location, e.g. `/session?session=abc&dir=%2Ftmp`. */
  href: string;
}

/** The persisted shape — the tab list plus which one is active. */
interface PersistedTabs {
  tabs: AppTab[];
  activeTabId: string | null;
}

/**
 * `sessionStorage` key. Per browser tab / per Electron renderer by design, so
 * two DorkOS windows never contend over one tab list (the same reasoning as the
 * terminal's `dork.terminal.tabs`).
 */
const STORAGE_KEY = 'dork.app-tabs';

/** Mint a tab id. `crypto.randomUUID` is available in every surface we ship. */
function newTabId(): string {
  return crypto.randomUUID();
}

/**
 * Read the persisted tabs, or `null` when there is nothing usable — absent or
 * blocked storage (private mode), corrupt JSON, a shape from an older build. An
 * `activeTabId` that no longer names a tab falls back to the first.
 *
 * @internal Exported for testing only.
 */
export function readPersistedTabs(): PersistedTabs | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { tabs, activeTabId } = parsed as { tabs?: unknown; activeTabId?: unknown };
    const clean = Array.isArray(tabs)
      ? tabs.filter(
          (tab): tab is AppTab =>
            typeof tab === 'object' &&
            tab !== null &&
            typeof (tab as AppTab).id === 'string' &&
            typeof (tab as AppTab).href === 'string' &&
            (tab as AppTab).href.length > 0
        )
      : [];
    if (clean.length === 0) return null;
    const active =
      typeof activeTabId === 'string' && clean.some((tab) => tab.id === activeTabId)
        ? activeTabId
        : clean[0].id;
    return { tabs: clean, activeTabId: active };
  } catch {
    return null;
  }
}

/**
 * The starting tab for a window with nothing stored: wherever this page already
 * is. Seeding synchronously (rather than waiting for the router's first sync)
 * is what keeps the strip from appearing a frame late and shoving the header
 * down — and on macOS the strip carries the traffic-light clearance, so a late
 * strip would flash the header out from under the window buttons.
 *
 * A location the router does not serve — the `file://` renderer fallback, a
 * stray path — seeds the dashboard instead of an href no tab could ever match.
 *
 * @internal Exported for testing only.
 */
export function seedTabsFromLocation(): PersistedTabs {
  if (typeof window === 'undefined') return { tabs: [], activeTabId: null };
  const link = classifyLink(window.location.href);
  const tab: AppTab = { id: newTabId(), href: link.kind === 'internal' ? link.path : '/' };
  return { tabs: [tab], activeTabId: tab.id };
}

/** Persist the tab list. Non-fatal on failure — you just lose restore-on-reload. */
function writePersistedTabs(state: PersistedTabs): void {
  try {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ tabs: state.tabs, activeTabId: state.activeTabId })
    );
  } catch {
    // Storage blocked or full — tabs still work for this window's lifetime.
  }
}

/** Tab list state and the four transitions that can change it. */
interface AppTabsState extends PersistedTabs {
  /**
   * Open `href` in a new tab, immediately to the right of the active one
   * (Chrome's placement), and make it active. Always creates — asking for a new
   * tab and getting a focus change instead is the one thing a tab strip must
   * not do. The caller navigates to `href` afterwards; {@link syncLocation}
   * then confirms the match, or lets the new tab adopt wherever a route loader
   * redirected it (`/session?dir=…` resolving to a concrete session).
   *
   * @param href - Router-relative location for the new tab.
   */
  openTab: (href: string) => void;
  /**
   * Close a tab. Refuses to close the last one — a window with no tabs has
   * nothing to show, and on desktop closing the last tab is the window's job,
   * not ours. When the closed tab was active, its right-hand neighbour takes
   * over (falling back to the left when it was last).
   *
   * @param id - Id of the tab to close.
   */
  closeTab: (id: string) => void;
  /**
   * Make a tab active. The caller navigates to its href; the reconciler then
   * confirms the match. Ignores an id that names no tab.
   *
   * @param id - Id of the tab to activate.
   */
  selectTab: (id: string) => void;
  /**
   * Reconcile the tab set against the router's current location — the module
   * doc's four-step rule. Called on every location change, whatever caused it:
   * a link, the command palette, a `dorkos://` deep link, a route loader
   * redirect, or Back/Forward.
   *
   * @param href - The router's current relative location.
   */
  syncLocation: (href: string) => void;
}

/**
 * The window's tab list. A plain Zustand store rather than router state: tabs
 * are window furniture, not part of any address.
 */
export const useAppTabsStore = create<AppTabsState>((set) => ({
  ...(readPersistedTabs() ?? seedTabsFromLocation()),

  openTab: (href) =>
    set((state) => {
      const tab: AppTab = { id: newTabId(), href };
      const activeIndex = state.tabs.findIndex((t) => t.id === state.activeTabId);
      const tabs = [...state.tabs];
      tabs.splice(activeIndex >= 0 ? activeIndex + 1 : tabs.length, 0, tab);
      return { tabs, activeTabId: tab.id };
    }),

  closeTab: (id) =>
    set((state) => {
      if (state.tabs.length <= 1) return state;
      const index = state.tabs.findIndex((t) => t.id === id);
      if (index === -1) return state;
      const tabs = state.tabs.filter((t) => t.id !== id);
      if (state.activeTabId !== id) return { tabs, activeTabId: state.activeTabId };
      // The neighbour that slid into this index, else the one before it.
      const next = tabs[index] ?? tabs[index - 1];
      return { tabs, activeTabId: next.id };
    }),

  selectTab: (id) =>
    set((state) => (state.tabs.some((t) => t.id === id) ? { activeTabId: id } : state)),

  syncLocation: (href) =>
    set((state) => {
      const active = state.tabs.find((t) => t.id === state.activeTabId) ?? null;
      if (active?.href === href) return state;

      const match = state.tabs.find((t) => t.href === href);
      if (match) return { activeTabId: match.id };

      if (active) {
        return { tabs: state.tabs.map((t) => (t.id === active.id ? { ...t, href } : t)) };
      }

      const tab: AppTab = { id: newTabId(), href };
      return { tabs: [...state.tabs, tab], activeTabId: tab.id };
    }),
}));

// Write-through persistence. Subscribing here (rather than inside each action)
// keeps the transitions above pure state math and guarantees no future action
// can forget to save.
useAppTabsStore.subscribe((state) => writePersistedTabs(state));

/** Subscribe to the ordered tab list. */
export function useAppTabs(): AppTab[] {
  return useAppTabsStore((s) => s.tabs);
}
