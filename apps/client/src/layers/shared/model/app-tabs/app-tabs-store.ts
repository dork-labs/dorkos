/**
 * The desktop app's in-window tabs (DOR-540).
 *
 * **Written only in the desktop shell** (DOR-568): a browser owns its own tabs,
 * so nothing there reconciles into this store and nothing there persists it. The
 * store still exists on every surface — it is what the strip and the link seam
 * are wired to — it simply never changes outside the desktop app.
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
 * 2. **Only when the browser traversed history** (Back/Forward): if the active
 *    tab's own previous or next entry is this location, its cursor steps there;
 *    otherwise, if another tab sits at exactly this location, that tab becomes
 *    active.
 * 3. Otherwise the active tab **adopts** the location, exactly like navigating
 *    inside a browser tab changes what that tab holds.
 * 4. No tabs at all (first paint) → mint one for wherever we landed.
 *
 * **Rule 2 is scoped to history traversal on purpose**, and that scope is the
 * whole correctness argument. Rule 2 exists to serve Back/Forward: after
 * switching tabs, Back returns to the previous tab's location and rule 2
 * re-activates that tab. Everywhere else, a location change is the active tab
 * going somewhere, and handing focus to a sibling that happens to sit at the
 * same href would be a teleport the operator never asked for. Two tabs sharing
 * an href is an ordinary state — `Cmd+T` from the dashboard produces it
 * immediately — so an unscoped rule 2 breaks two everyday paths:
 *
 * - **Opening a tab.** `openTab` mints a tab on a transient href
 *   (`/session?dir=…`) that the route loader immediately resolves to
 *   `/session?session=S&dir=…`. If any other tab already sits at the resolved
 *   href, an unscoped rule 2 focuses that sibling and strands the new tab on a
 *   location that can never survive its own loader — a tab that does nothing
 *   forever, and a silent breach of {@link AppTabsState.openTab}'s contract.
 * - **Closing a URL-backed dialog.** `?settings=open` (and `?agent=`, `?tasks=`)
 *   is a modifier on wherever you are. Opening it moves the active tab to
 *   `/?settings=open`; closing it returns to `/`. With a second tab sitting at
 *   `/`, an unscoped rule 2 jumps focus there and leaves the tab you were in
 *   parked on `/?settings=open`, so returning to it reopens the dialog.
 *
 * Gating on traversal fixes both with one rule rather than a special case each,
 * and it does not lean on href equality to tell them apart — which matters,
 * because href equality is a serialization detail that can drift.
 *
 * Navigating **within** a tab rewrites that tab's href (rule 3), so Back rewinds
 * the tab's own content rather than teleporting between tabs. No tab state is
 * ever written into the URL — a link you copy addresses a session, never a
 * window layout.
 *
 * **Each tab keeps its own history** (DOR-2107). The window has one browser
 * history stack shared by every tab, so exposing it as Back would walk through
 * tab switches and into closed tabs' pasts. Instead every tab carries
 * `history` and a `cursor` into it, with `history[cursor] === href` always.
 * Only rule 3 adds or rewrites entries: a new entry (PUSH) drops anything ahead of the
 * cursor and appends, like a browser forgetting Forward; a REPLACE (a loader
 * redirect, a search-param update) rewrites the current entry in place, and so
 * does opening or closing a URL-backed dialog (`?settings=`, `?tasks=`, …),
 * which changes what is over the page, not the page (which params count is
 * `DIALOG_MODIFIER_KEYS`; a profile is an address and is left to the router).
 * Two identical entries are never left side by side. Rule 2's cursor step
 * moves through entries without recording any; rule 1 and tab switches record
 * nothing. Back, Forward and the History menu
 * move the cursor here first ({@link AppTabsState.goToHistoryIndex}) and then
 * navigate, so the sync that follows hits rule 1.
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
import { DIALOG_MODIFIER_KEYS } from '../dialog-search-schema';

/** One tab: a stable client id, the location it holds, and where it has been. */
export interface AppTab {
  /** Stable client-side id. Never leaves the renderer. */
  id: string;
  /** Router-relative location, e.g. `/session?session=abc&dir=%2Ftmp`. */
  href: string;
  /** Pages this tab has shown, oldest first. Always holds `href` at `cursor`. */
  history: string[];
  /** Index into `history` of the page the tab shows now. */
  cursor: number;
}

/**
 * Most pages one tab remembers. Past this, the oldest entry is dropped. Fifty
 * short strings per tab is nothing to persist, and nobody presses Back fifty
 * times.
 */
export const MAX_TAB_HISTORY = 50;

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

/** A brand-new tab at `href`, with that one page as its whole history. */
function mintTab(href: string): AppTab {
  return { id: newTabId(), href, history: [href], cursor: 0 };
}

/**
 * Move a tab somewhere new: drop every entry ahead of the cursor (Forward is
 * forgotten, as in a browser), append, and trim the oldest past the cap.
 */
function pushEntry(tab: AppTab, href: string): AppTab {
  const history = [...tab.history.slice(0, tab.cursor + 1), href].slice(-MAX_TAB_HISTORY);
  return { ...tab, href, history, cursor: history.length - 1 };
}

/** Rewrite the tab's current entry in place — a redirect, not a new page. */
function replaceEntry(tab: AppTab, href: string): AppTab {
  const history = [...tab.history];
  history[tab.cursor] = href;
  return { ...tab, href, history };
}

/**
 * Fold the current entry into an identical neighbour. Two equal entries side by
 * side make Back or Forward a press that visibly does nothing, and list one page
 * twice in the History menu — a replace that lands on the page before (a
 * redirect back to where you were) is the usual way to get them.
 */
function collapseDuplicates(tab: AppTab): AppTab {
  const history = [...tab.history];
  let cursor = tab.cursor;
  // Both sides, in turn: a replace in the middle of `[a, b, a]` with `a`
  // matches each neighbour, and folding only one would leave `[a, a]`.
  if (history[cursor + 1] === tab.href) history.splice(cursor + 1, 1);
  if (cursor > 0 && history[cursor - 1] === tab.href) {
    history.splice(cursor, 1);
    cursor -= 1;
  }
  return history.length === tab.history.length ? tab : { ...tab, history, cursor };
}

/** Absolute base used only to make relative hrefs parseable. Never navigated to. */
const PARSE_BASE = 'http://tab.local';

/** An href with every dialog-modifier search param removed, search sorted. */
function withoutDialogParams(href: string): string | null {
  try {
    const url = new URL(href, PARSE_BASE);
    for (const key of DIALOG_MODIFIER_KEYS) url.searchParams.delete(key);
    url.searchParams.sort();
    return `${url.pathname}?${url.searchParams.toString()}${url.hash}`;
  } catch {
    return null;
  }
}

/**
 * Whether two hrefs are the same page with a different dialog over it
 * (`/` and `/?settings=open`). Opening or closing Settings is not going
 * anywhere, so it must not leave a Back press that reopens it.
 */
function differsOnlyByDialog(a: string, b: string): boolean {
  const bare = withoutDialogParams(a);
  return bare !== null && bare === withoutDialogParams(b);
}

/**
 * A traversal onto the tab's own neighbouring entry (a `router.history.back()`
 * the app made itself) steps the cursor there. `null` when neither neighbour is
 * `href`.
 */
function stepToNeighbour(tab: AppTab, href: string): AppTab | null {
  if (tab.history[tab.cursor - 1] === href) return { ...tab, href, cursor: tab.cursor - 1 };
  if (tab.history[tab.cursor + 1] === href) return { ...tab, href, cursor: tab.cursor + 1 };
  return null;
}

/**
 * How the active tab takes on a location it does not hold — rule 3. A replace,
 * or a modal dialog opening or closing, rewrites the current entry; anything
 * else is a new page.
 */
function adoptLocation(tab: AppTab, href: string, replace: boolean): AppTab {
  const moved =
    replace || differsOnlyByDialog(tab.href, href) ? replaceEntry(tab, href) : pushEntry(tab, href);
  return collapseDuplicates(moved);
}

/**
 * A stored tab, made whole. An entry from before per-tab history (`{ id, href }`)
 * or one whose history is malformed keeps its tab and restarts its history at
 * its current page — losing someone's Back stack is a shrug, losing their tab
 * is not. Returns `null` only when there is no tab to keep (no id or href).
 */
function repairTab(raw: unknown): AppTab | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { id, href, history, cursor } = raw as Partial<Record<keyof AppTab, unknown>>;
  if (typeof id !== 'string' || typeof href !== 'string' || href.length === 0) return null;
  const historyIsSound =
    Array.isArray(history) &&
    history.length > 0 &&
    history.length <= MAX_TAB_HISTORY &&
    history.every((entry) => typeof entry === 'string') &&
    Number.isInteger(cursor) &&
    (cursor as number) >= 0 &&
    (cursor as number) < history.length &&
    history[cursor as number] === href;
  if (!historyIsSound) return { id, href, history: [href], cursor: 0 };
  return { id, href, history: [...(history as string[])], cursor: cursor as number };
}

/**
 * Read the persisted tabs, or `null` when there is nothing usable — absent or
 * blocked storage (private mode), corrupt JSON, a shape with no usable tab. An
 * `activeTabId` that no longer names a tab falls back to the first. A tab whose
 * history is missing or broken is repaired, never dropped.
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
      ? tabs.map(repairTab).filter((tab): tab is AppTab => tab !== null)
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
  const tab = mintTab(link.kind === 'internal' ? link.path : '/');
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

/** Tab list state and the transitions that can change it. */
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
   * @param options - `traversal` marks a location the browser reached by moving
   *   through history (Back/Forward) rather than by the app navigating
   *   somewhere new. It is the only thing that lets focus move to another tab;
   *   see the module doc for why nothing else may. Defaults to `false`, so a
   *   caller that cannot tell gets the safe answer — the active tab keeps
   *   focus and adopts. `replace` marks a location that took the place of the
   *   current one (a router `REPLACE`: a loader redirect, a search-param
   *   update), so the adopting tab rewrites its current history entry rather
   *   than adding one. Defaults to `false`: a new entry.
   */
  syncLocation: (href: string, options?: { traversal?: boolean; replace?: boolean }) => void;
  /**
   * Move the active tab to entry `index` of its own history — the store half of
   * Back, Forward and the History menu. Sets the cursor and the href together,
   * so the navigation that follows finds the tab already there (rule 1) and
   * records nothing. An index out of range, or the one the tab is already on,
   * changes nothing.
   *
   * @param index - Position in the active tab's `history`, oldest first.
   */
  goToHistoryIndex: (index: number) => void;
}

/**
 * The window's tab list. A plain Zustand store rather than router state: tabs
 * are window furniture, not part of any address.
 */
export const useAppTabsStore = create<AppTabsState>((set) => ({
  ...(readPersistedTabs() ?? seedTabsFromLocation()),

  openTab: (href) =>
    set((state) => {
      const tab = mintTab(href);
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

  syncLocation: (href, { traversal = false, replace = false } = {}) =>
    set((state) => {
      const active = state.tabs.find((t) => t.id === state.activeTabId) ?? null;
      if (active?.href === href) return state;

      if (traversal) {
        // The tab's own history first: a traversal onto its neighbouring entry
        // is this tab moving, even when a sibling happens to hold that href
        // (`/` after Cmd+T is the everyday case).
        const stepped = active ? stepToNeighbour(active, href) : null;
        if (active && stepped) {
          return { tabs: state.tabs.map((t) => (t.id === active.id ? stepped : t)) };
        }
        const match = state.tabs.find((t) => t.href === href);
        if (match) return { activeTabId: match.id };
      }

      if (active) {
        const moved = adoptLocation(active, href, replace);
        return { tabs: state.tabs.map((t) => (t.id === active.id ? moved : t)) };
      }

      const tab = mintTab(href);
      return { tabs: [...state.tabs, tab], activeTabId: tab.id };
    }),

  goToHistoryIndex: (index) =>
    set((state) => {
      const active = state.tabs.find((t) => t.id === state.activeTabId);
      if (!active || !Number.isInteger(index)) return state;
      if (index < 0 || index >= active.history.length || index === active.cursor) return state;
      const moved: AppTab = { ...active, href: active.history[index], cursor: index };
      return { tabs: state.tabs.map((t) => (t.id === active.id ? moved : t)) };
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

/** The active tab's history, as Back, Forward and the History menu read it. */
export interface ActiveTabHistory {
  /** Pages the active tab has shown, oldest first. Empty with no active tab. */
  entries: string[];
  /** Index into `entries` of the page on screen. */
  cursor: number;
  /** Whether there is an entry behind the cursor. */
  canGoBack: boolean;
  /** Whether there is an entry ahead of the cursor. */
  canGoForward: boolean;
}

/** Shared empty answer, so a window with no active tab re-renders nothing. */
const NO_HISTORY: string[] = [];

/**
 * Subscribe to the active tab's history. Selects the history array and the
 * cursor separately — both keep their identity until that tab moves — so a
 * change to any other tab re-renders nothing.
 */
export function useActiveTabHistory(): ActiveTabHistory {
  const entries = useAppTabsStore(
    (s) => s.tabs.find((t) => t.id === s.activeTabId)?.history ?? NO_HISTORY
  );
  const cursor = useAppTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.cursor ?? 0);
  return {
    entries,
    cursor,
    canGoBack: cursor > 0,
    canGoForward: cursor < entries.length - 1,
  };
}
