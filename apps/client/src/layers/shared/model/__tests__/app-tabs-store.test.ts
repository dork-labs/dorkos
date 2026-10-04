/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  useAppTabsStore,
  readPersistedTabs,
  seedTabsFromLocation,
  MAX_TAB_HISTORY,
  type AppTab,
} from '../app-tabs/app-tabs-store';

const STORAGE_KEY = 'dork.app-tabs';

/** Seed the store with named tabs so assertions read like the strip looks. */
function setTabs(hrefs: string[], activeIndex = 0): AppTab[] {
  const tabs = hrefs.map((href, index) => ({
    id: `tab-${index}`,
    href,
    history: [href],
    cursor: 0,
  }));
  useAppTabsStore.setState({ tabs, activeTabId: tabs[activeIndex]?.id ?? null });
  return tabs;
}

/** The strip as a person sees it: hrefs in order, with the active one marked. */
function strip(): string[] {
  const { tabs, activeTabId } = useAppTabsStore.getState();
  return tabs.map((tab) => (tab.id === activeTabId ? `[${tab.href}]` : tab.href));
}

/** The active tab, read straight from the store. */
function active(): AppTab {
  const { tabs, activeTabId } = useAppTabsStore.getState();
  const tab = tabs.find((t) => t.id === activeTabId);
  if (!tab) throw new Error('no active tab');
  return tab;
}

/** A tab's history as a person reads it: entries in order, the current one marked. */
function trail(tab: AppTab = active()): string[] {
  return tab.history.map((href, index) => (index === tab.cursor ? `[${href}]` : href));
}

/** Walk the active tab through `hrefs` as ordinary navigations (rule 3 pushes). */
function visit(...hrefs: string[]): void {
  for (const href of hrefs) useAppTabsStore.getState().syncLocation(href);
}

/** The invariant every action keeps: each tab's history holds its href at the cursor. */
function expectInvariant(): void {
  for (const tab of useAppTabsStore.getState().tabs) {
    expect(Number.isInteger(tab.cursor)).toBe(true);
    expect(tab.history.length).toBeGreaterThan(0);
    expect(tab.history.length).toBeLessThanOrEqual(MAX_TAB_HISTORY);
    expect(tab.history[tab.cursor]).toBe(tab.href);
  }
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  sessionStorage.clear();
});

describe('openTab', () => {
  it('inserts to the right of the active tab and focuses it', () => {
    setTabs(['/', '/team'], 0);
    useAppTabsStore.getState().openTab('/tasks');
    expect(strip()).toEqual(['/', '[/tasks]', '/team']);
  });

  it('always creates, even when that location is already open', () => {
    // Asking for a new tab and getting a focus change instead is the one thing
    // a tab strip must not do.
    setTabs(['/'], 0);
    useAppTabsStore.getState().openTab('/');
    expect(strip()).toEqual(['/', '[/]']);
  });

  it('appends when nothing is active', () => {
    useAppTabsStore.setState({ tabs: [], activeTabId: null });
    useAppTabsStore.getState().openTab('/team');
    expect(strip()).toEqual(['[/team]']);
  });
});

describe('closeTab', () => {
  it('refuses to close the last tab', () => {
    const [only] = setTabs(['/session?session=a']);
    useAppTabsStore.getState().closeTab(only.id);
    expect(strip()).toEqual(['[/session?session=a]']);
  });

  it('hands focus to the right-hand neighbour', () => {
    const tabs = setTabs(['/', '/team', '/tasks'], 1);
    useAppTabsStore.getState().closeTab(tabs[1].id);
    expect(strip()).toEqual(['/', '[/tasks]']);
  });

  it('falls back to the left when the last tab closes', () => {
    const tabs = setTabs(['/', '/team'], 1);
    useAppTabsStore.getState().closeTab(tabs[1].id);
    expect(strip()).toEqual(['[/]']);
  });

  it('leaves the active tab alone when a background tab closes', () => {
    const tabs = setTabs(['/', '/team', '/tasks'], 2);
    useAppTabsStore.getState().closeTab(tabs[0].id);
    expect(strip()).toEqual(['/team', '[/tasks]']);
  });

  it('ignores an id that names no tab', () => {
    setTabs(['/', '/team'], 0);
    useAppTabsStore.getState().closeTab('nope');
    expect(strip()).toEqual(['[/]', '/team']);
  });
});

describe('selectTab', () => {
  it('moves focus', () => {
    const tabs = setTabs(['/', '/team'], 0);
    useAppTabsStore.getState().selectTab(tabs[1].id);
    expect(strip()).toEqual(['/', '[/team]']);
  });

  it('ignores an id that names no tab', () => {
    setTabs(['/', '/team'], 0);
    useAppTabsStore.getState().selectTab('nope');
    expect(strip()).toEqual(['[/]', '/team']);
  });
});

describe('syncLocation — the URL is the active tab', () => {
  it('does nothing when the active tab is already there', () => {
    setTabs(['/', '/team'], 1);
    const before = useAppTabsStore.getState().tabs;
    useAppTabsStore.getState().syncLocation('/team');
    expect(useAppTabsStore.getState().tabs).toBe(before);
    expect(strip()).toEqual(['/', '[/team]']);
  });

  it('lets the active tab adopt a location no tab holds (navigating inside a tab)', () => {
    setTabs(['/', '/team'], 1);
    useAppTabsStore.getState().syncLocation('/tasks');
    expect(strip()).toEqual(['/', '[/tasks]']);
  });

  it('mints a tab when the window has none', () => {
    useAppTabsStore.setState({ tabs: [], activeTabId: null });
    useAppTabsStore.getState().syncLocation('/activity');
    expect(strip()).toEqual(['[/activity]']);
  });
});

describe('syncLocation — only a history traversal may move focus', () => {
  it('re-activates the tab holding the location on Back after a tab switch', () => {
    setTabs(['/session?session=a', '/session?session=b'], 1);
    useAppTabsStore.getState().syncLocation('/session?session=a', { traversal: true });
    expect(strip()).toEqual(['[/session?session=a]', '/session?session=b']);
  });

  it('keeps the active tab when two tabs share the traversed-to location', () => {
    const tabs = setTabs(['/', '/'], 1);
    useAppTabsStore.getState().syncLocation('/', { traversal: true });
    expect(useAppTabsStore.getState().activeTabId).toBe(tabs[1].id);
  });

  it('does not hand focus to a sibling on an ordinary navigation', () => {
    // The everyday two-tabs-one-href state: Cmd+T from the dashboard makes it.
    const tabs = setTabs(['/', '/'], 1);
    useAppTabsStore.getState().syncLocation('/?settings=open');
    useAppTabsStore.getState().syncLocation('/');
    expect(useAppTabsStore.getState().activeTabId).toBe(tabs[1].id);
    expect(strip()).toEqual(['/', '[/]']);
  });

  it('leaves no tab parked on a dialog after a settings open/close cycle', () => {
    // Regression: rule 2 used to fire here, jumping focus to the first tab and
    // stranding the second on `/?settings=open` — so returning to it reopened
    // the dialog. Every `?settings=` / `?agent=` / `?tasks=` link has this shape.
    setTabs(['/', '/'], 1);
    useAppTabsStore.getState().syncLocation('/?settings=open');
    expect(strip()).toEqual(['/', '[/?settings=open]']);

    useAppTabsStore.getState().syncLocation('/');
    expect(useAppTabsStore.getState().tabs.map((tab) => tab.href)).toEqual(['/', '/']);
  });

  it('lets a freshly opened tab adopt its own loader redirect', () => {
    // `openTab('/session?dir=/api')` lands on the session the loader picked.
    setTabs(['/'], 0);
    useAppTabsStore.getState().openTab('/session?dir=%2Fapi');
    useAppTabsStore.getState().syncLocation('/session?session=abc&dir=%2Fapi');
    expect(strip()).toEqual(['/', '[/session?session=abc&dir=%2Fapi]']);
  });

  it('keeps the new tab even when a sibling already holds the resolved session', () => {
    // Regression (the headline path): "Open in a new tab" on an agent someone is
    // already reading. Rule 2 used to focus the sibling and strand the new tab
    // on `/session?dir=…`, a location its own loader redirects away from every
    // time it is clicked — a tab that can never do anything.
    const resolved = '/session?session=abc&dir=%2Fapi';
    setTabs([resolved], 0);
    useAppTabsStore.getState().openTab('/session?dir=%2Fapi');
    const opened = useAppTabsStore.getState().activeTabId;

    useAppTabsStore.getState().syncLocation(resolved);

    expect(useAppTabsStore.getState().activeTabId).toBe(opened);
    expect(useAppTabsStore.getState().tabs.map((tab) => tab.href)).toEqual([resolved, resolved]);
    // Two live tabs on one session is the honest outcome of "always creates";
    // a tab stuck on a transient href is not.
    expect(strip()).toEqual([resolved, `[${resolved}]`]);
  });
});

describe('persistence', () => {
  it('writes through on every change and reads back', () => {
    setTabs(['/', '/team'], 1);
    useAppTabsStore.getState().openTab('/tasks');
    const restored = readPersistedTabs();
    expect(restored?.tabs.map((tab) => tab.href)).toEqual(['/', '/team', '/tasks']);
    expect(restored?.activeTabId).toBe(useAppTabsStore.getState().activeTabId);
  });

  it('reports nothing stored rather than throwing on corrupt data', () => {
    sessionStorage.setItem(STORAGE_KEY, '{not json');
    expect(readPersistedTabs()).toBeNull();
  });

  it('drops malformed tab entries and an empty result', () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ tabs: [{ id: 7 }, {}], activeTabId: 'x' })
    );
    expect(readPersistedTabs()).toBeNull();
  });

  it('falls back to the first tab when the stored active id is gone', () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ tabs: [{ id: 'a', href: '/' }], activeTabId: 'vanished' })
    );
    expect(readPersistedTabs()?.activeTabId).toBe('a');
  });
});

describe('seedTabsFromLocation', () => {
  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('starts a fresh window on the page it is already showing', () => {
    window.history.replaceState({}, '', '/session?session=abc');
    const seeded = seedTabsFromLocation();
    expect(seeded.tabs.map((tab) => tab.href)).toEqual(['/session?session=abc']);
    expect(seeded.activeTabId).toBe(seeded.tabs[0].id);
  });

  it('falls back to the dashboard for a location the router does not serve', () => {
    // The packaged `file://` renderer fallback lands here; an href no tab could
    // ever match would be worse than the one route that always works.
    window.history.replaceState({}, '', '/api/docs');
    expect(seedTabsFromLocation().tabs.map((tab) => tab.href)).toEqual(['/']);
  });
});

describe('per-tab history (DOR-2107)', () => {
  it('starts a new tab with its own page as its whole history', () => {
    // Purpose: a fresh tab must not inherit the opener's Back stack.
    setTabs(['/'], 0);
    visit('/team');
    useAppTabsStore.getState().openTab('/tasks');
    expect(trail()).toEqual(['[/tasks]']);
  });

  it('appends each ordinary navigation to the active tab', () => {
    // Purpose: rule 3 with a PUSH is what fills the Back stack at all.
    setTabs(['/'], 0);
    visit('/team', '/tasks');
    expect(trail()).toEqual(['/', '/team', '[/tasks]']);
  });

  it('forgets Forward when you go somewhere new from the middle', () => {
    // Purpose: browser semantics — a push from behind the head truncates.
    setTabs(['/'], 0);
    visit('/team', '/tasks');
    useAppTabsStore.getState().goToHistoryIndex(0);
    visit('/activity');
    expect(trail()).toEqual(['/', '[/activity]']);
  });

  it('rewrites the current entry on a replace instead of adding one', () => {
    // Purpose: a loader redirect must not leave a Back press that bounces
    // straight back through the same redirect.
    setTabs(['/'], 0);
    visit('/session?dir=%2Fapi');
    useAppTabsStore.getState().syncLocation('/session?session=abc&dir=%2Fapi', { replace: true });
    expect(trail()).toEqual(['/', '[/session?session=abc&dir=%2Fapi]']);
  });

  it('keeps Forward intact when a jumped-to entry is replaced', () => {
    // Purpose: a redirect after Back rewrites that entry only, never the future.
    setTabs(['/'], 0);
    visit('/session?dir=%2Fapi', '/team');
    useAppTabsStore.getState().goToHistoryIndex(1);
    useAppTabsStore.getState().syncLocation('/session?session=s&dir=%2Fapi', { replace: true });
    expect(trail()).toEqual(['/', '[/session?session=s&dir=%2Fapi]', '/team']);
  });

  it('drops the oldest entry past the cap and keeps the invariant', () => {
    // Purpose: history is bounded, and trimming must shift the cursor with it.
    setTabs(['/p0'], 0);
    for (let i = 1; i <= MAX_TAB_HISTORY + 5; i += 1) visit(`/p${i}`);
    const tab = active();
    expect(tab.history).toHaveLength(MAX_TAB_HISTORY);
    expect(tab.history[0]).toBe('/p6');
    expect(tab.cursor).toBe(MAX_TAB_HISTORY - 1);
    expectInvariant();
  });

  it('records nothing when the active tab is already there (rule 1)', () => {
    // Purpose: Back/Forward and tab switches rely on rule 1 to stay silent.
    setTabs(['/'], 0);
    visit('/team');
    const before = active().history;
    useAppTabsStore.getState().syncLocation('/team');
    expect(active().history).toBe(before);
  });

  it('records nothing in either tab when a traversal focuses a sibling (rule 2)', () => {
    // Purpose: rule 2 moves focus, never a stack.
    const tabs = setTabs(['/', '/team'], 1);
    useAppTabsStore.getState().syncLocation('/', { traversal: true });
    const after = useAppTabsStore.getState().tabs;
    expect(after[0]).toBe(tabs[0]);
    expect(after[1]).toBe(tabs[1]);
  });

  it('leaves both stacks alone when switching tabs', () => {
    // Purpose: the old shared stack grew on every switch; per-tab stacks must not.
    const tabs = setTabs(['/', '/team'], 0);
    visit('/tasks');
    useAppTabsStore.getState().selectTab(tabs[1].id);
    // `goToActiveTab` then navigates to the tab's own href: rule 1.
    useAppTabsStore.getState().syncLocation('/team');
    useAppTabsStore.getState().selectTab(tabs[0].id);
    useAppTabsStore.getState().syncLocation('/tasks');
    const [first, second] = useAppTabsStore.getState().tabs;
    expect(trail(first)).toEqual(['/', '[/tasks]']);
    expect(trail(second)).toEqual(['[/team]']);
  });

  it('closing a tab leaves the survivor its own history', () => {
    // Purpose: the old shared stack let Back adopt a closed tab's past.
    const tabs = setTabs(['/', '/team'], 0);
    visit('/tasks');
    useAppTabsStore.getState().selectTab(tabs[1].id);
    useAppTabsStore.getState().closeTab(tabs[1].id);
    expect(trail()).toEqual(['/', '[/tasks]']);
  });

  it('mints a fresh stack when the window has no tabs (rule 4)', () => {
    // Purpose: the first-paint tab obeys the invariant too.
    useAppTabsStore.setState({ tabs: [], activeTabId: null });
    useAppTabsStore.getState().syncLocation('/activity');
    expect(trail()).toEqual(['[/activity]']);
  });
});

describe('goToHistoryIndex', () => {
  it('moves the cursor and the href together', () => {
    // Purpose: setting both first is what lets the navigation hit rule 1.
    setTabs(['/'], 0);
    visit('/team', '/tasks');
    useAppTabsStore.getState().goToHistoryIndex(1);
    expect(active().href).toBe('/team');
    expect(trail()).toEqual(['/', '[/team]', '/tasks']);
  });

  it('is a no-op, returning the same state, out of range or on the current entry', () => {
    // Purpose: Back at the start and Forward at the end must change nothing at all.
    setTabs(['/'], 0);
    visit('/team');
    const before = useAppTabsStore.getState();
    for (const index of [-1, 2, 1, 0.5]) {
      useAppTabsStore.getState().goToHistoryIndex(index);
      expect(useAppTabsStore.getState(), String(index)).toBe(before);
    }
  });

  it('only moves the active tab', () => {
    // Purpose: Back is per tab; a background tab never moves.
    const tabs = setTabs(['/', '/team'], 0);
    visit('/tasks');
    useAppTabsStore.getState().selectTab(tabs[1].id);
    visit('/activity');
    useAppTabsStore.getState().goToHistoryIndex(0);
    const [first, second] = useAppTabsStore.getState().tabs;
    expect(trail(first)).toEqual(['/', '[/tasks]']);
    expect(trail(second)).toEqual(['[/team]', '/activity']);
  });
});

describe('history invariant under random actions', () => {
  it('holds history[cursor] === href after every one of 500 seeded steps', () => {
    // Purpose: no sequence of actions may break the invariant the controls
    // and persistence rely on. Deterministic PRNG so a failure reproduces.
    let seed = 2107;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
    const hrefs = ['/', '/team', '/tasks', '/activity', '/session?session=a', '/channels?id=r'];

    setTabs(['/'], 0);
    for (let step = 0; step < 500; step += 1) {
      const store = useAppTabsStore.getState();
      const roll = random();
      if (roll < 0.35) store.syncLocation(pick(hrefs));
      else if (roll < 0.45) store.syncLocation(pick(hrefs), { replace: true });
      else if (roll < 0.55) store.syncLocation(pick(hrefs), { traversal: true });
      else if (roll < 0.75) store.goToHistoryIndex(Math.floor(random() * 8) - 2);
      else if (roll < 0.83) store.openTab(pick(hrefs));
      else if (roll < 0.91) store.selectTab(pick(store.tabs).id);
      else store.closeTab(pick(store.tabs).id);
      expectInvariant();
    }
  });
});

describe('persistence of history', () => {
  it('round-trips each tab’s history and cursor', () => {
    // Purpose: a reload keeps Back working, exactly as it keeps the tab.
    setTabs(['/'], 0);
    visit('/team', '/tasks');
    useAppTabsStore.getState().goToHistoryIndex(1);
    const restored = readPersistedTabs();
    expect(restored?.tabs[0]).toMatchObject({
      href: '/team',
      history: ['/', '/team', '/tasks'],
      cursor: 1,
    });
  });

  it('repairs a tab saved before per-tab history instead of dropping it', () => {
    // Purpose: upgrading mid-session must not cost anyone their tabs.
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ tabs: [{ id: 'a', href: '/team' }], activeTabId: 'a' })
    );
    expect(readPersistedTabs()?.tabs).toEqual([
      { id: 'a', href: '/team', history: ['/team'], cursor: 0 },
    ]);
  });

  it('repairs corrupt history shapes and keeps every tab', () => {
    // Purpose: each broken shape restarts history at the tab's page; none drops it.
    const broken = [
      { id: 'a', href: '/a', history: 'nope', cursor: 0 },
      { id: 'b', href: '/b', history: ['/b', 7], cursor: 0 },
      { id: 'c', href: '/c', history: ['/x', '/c'], cursor: 5 },
      { id: 'd', href: '/d', history: ['/x', '/d'], cursor: 0.5 },
      { id: 'e', href: '/e', history: ['/x', '/y'], cursor: 1 },
      { id: 'f', href: '/f', history: [], cursor: 0 },
    ];
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs: broken, activeTabId: 'a' }));
    const restored = readPersistedTabs();
    expect(restored?.tabs).toEqual(
      broken.map(({ id, href }) => ({ id, href, history: [href], cursor: 0 }))
    );
  });

  it('keeps a sound stored history as it was', () => {
    // Purpose: repair must not fire on a healthy entry.
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        tabs: [{ id: 'a', href: '/b', history: ['/a', '/b', '/c'], cursor: 1 }],
        activeTabId: 'a',
      })
    );
    expect(readPersistedTabs()?.tabs[0]).toEqual({
      id: 'a',
      href: '/b',
      history: ['/a', '/b', '/c'],
      cursor: 1,
    });
  });
});
