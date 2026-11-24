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
    for (let i = 1; i < tab.history.length; i += 1) {
      expect(tab.history[i], 'identical adjacent entries').not.toBe(tab.history[i - 1]);
    }
  }
}

/** Seed one active tab with an explicit history and cursor. */
function setHistory(history: string[], cursor = history.length - 1): void {
  const tab = { id: 'tab-0', href: history[cursor], history, cursor };
  useAppTabsStore.setState({ tabs: [tab], activeTabId: tab.id });
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
});

describe('selectTab', () => {
  it('moves focus', () => {
    const tabs = setTabs(['/', '/team'], 0);
    useAppTabsStore.getState().selectTab(tabs[1].id);
    expect(strip()).toEqual(['/', '[/team]']);
  });
});

describe('syncLocation — the URL is the active tab', () => {
  it('lets the active tab adopt a location no tab holds (navigating inside a tab)', () => {
    setTabs(['/', '/team'], 1);
    useAppTabsStore.getState().syncLocation('/tasks');
    expect(strip()).toEqual(['/', '[/tasks]']);
  });
});

describe('syncLocation — only a history traversal may move focus', () => {
  it('re-activates the tab holding the location on Back after a tab switch', () => {
    setTabs(['/session?session=a', '/session?session=b'], 1);
    useAppTabsStore.getState().syncLocation('/session?session=a', { traversal: true });
    expect(strip()).toEqual(['[/session?session=a]', '/session?session=b']);
  });

  it('leaves no tab parked on a dialog after a settings open/close cycle', () => {
    // Regression: rule 2 used to fire here, jumping focus to the first tab and stranding the
    // second on `/?settings=open` — so returning to it reopened the dialog.
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
});

describe('per-tab history (DOR-2107)', () => {
  it('starts a new tab with its own page as its whole history', () => {
    // Purpose: a fresh tab must not inherit the opener's Back stack.
    setTabs(['/'], 0);
    visit('/team');
    useAppTabsStore.getState().openTab('/tasks');
    expect(trail()).toEqual(['[/tasks]']);
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
});

describe('per-tab history — a dialog is not a page', () => {
  it('records nothing when a URL-backed dialog opens and closes', () => {
    // Purpose: Back must not reopen Settings, and History must not list `/` twice.
    setTabs(['/'], 0);
    visit('/?settings=open');
    expect(trail()).toEqual(['[/?settings=open]']);
    visit('/');
    expect(trail()).toEqual(['[/]']);
  });

  it('keeps every step of a profile chain, so Back walks it', () => {
    // Purpose: a profile is an address — owner, then a managed agent, then a
    // page are three places the profile hooks push, and three Back presses.
    setTabs(['/team'], 0);
    visit('/team?profile=owner', '/team?profile=agent', '/team?profile=agent&profilePage=memory');
    expect(trail()).toEqual([
      '/team',
      '/team?profile=owner',
      '/team?profile=agent',
      '[/team?profile=agent&profilePage=memory]',
    ]);
  });
});

describe('per-tab history — no two identical entries side by side', () => {
  it('folds a replace that lands on the entry before it', () => {
    // Purpose: a redirect back to the previous page must not make Back a dead press.
    setHistory(['/a', '/b']);
    useAppTabsStore.getState().syncLocation('/a', { replace: true });
    expect(trail()).toEqual(['[/a]']);
  });
});

describe('per-tab history — a traversal the app made itself', () => {
  it('steps the tab’s own cursor before handing focus to a sibling at that href', () => {
    // Purpose: after Cmd+T a sibling often sits at `/`; an app-made
    // history.back() onto this tab's own previous `/` must not jump tabs.
    const sibling = { id: 'a', href: '/', history: ['/'], cursor: 0 };
    const mine = { id: 'b', href: '/team', history: ['/', '/team'], cursor: 1 };
    useAppTabsStore.setState({ tabs: [sibling, mine], activeTabId: 'b' });
    useAppTabsStore.getState().syncLocation('/', { traversal: true });
    expect(useAppTabsStore.getState().activeTabId).toBe('b');
    expect(trail()).toEqual(['[/]', '/team']);
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
});

describe('history invariant under random actions', () => {
  it('holds history[cursor] === href, with no identical neighbours, after 500 seeded steps', () => {
    // Purpose: no sequence of actions may break the invariant the controls
    // and persistence rely on. Deterministic PRNG so a failure reproduces.
    let seed = 2107;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
    const hrefs = [
      '/',
      '/team',
      '/tasks',
      '/activity',
      '/session?session=a',
      '/channels?id=r',
      '/?settings=open',
      '/team?tasks=open',
      '/team?profile=a',
    ];

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

describe('renameSessionInTabs (DOR-4622)', () => {
  it('points a background tab on the retired id at the new one, keeping its other params', () => {
    // A first send in Tab 1 resolved after the person switched to Tab 2: the
    // URL shows Tab 2, so Tab 1's own saved address is what gets renamed.
    setTabs(['/session?session=client-uuid&draft=1&dir=%2Fproj', '/session?session=B'], 1);
    useAppTabsStore.getState().renameSessionInTabs('client-uuid', 'canonical');
    expect(strip()).toEqual([
      '/session?session=canonical&draft=1&dir=%2Fproj',
      '[/session?session=B]',
    ]);
    expectInvariant();
  });

  it('renames older history entries too, and keeps the cursor where it was', () => {
    setHistory(['/session?session=client-uuid', '/', '/session?session=client-uuid&view=x'], 2);
    useAppTabsStore.getState().renameSessionInTabs('client-uuid', 'canonical');
    expect(trail()).toEqual([
      '/session?session=canonical',
      '/',
      '[/session?session=canonical&view=x]',
    ]);
    expectInvariant();
  });
});
