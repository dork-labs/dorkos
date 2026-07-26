/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  useAppTabsStore,
  readPersistedTabs,
  seedTabsFromLocation,
  type AppTab,
} from '../app-tabs/app-tabs-store';

const STORAGE_KEY = 'dork.app-tabs';

/** Seed the store with named tabs so assertions read like the strip looks. */
function setTabs(hrefs: string[], activeIndex = 0): AppTab[] {
  const tabs = hrefs.map((href, index) => ({ id: `tab-${index}`, href }));
  useAppTabsStore.setState({ tabs, activeTabId: tabs[activeIndex]?.id ?? null });
  return tabs;
}

/** The strip as a person sees it: hrefs in order, with the active one marked. */
function strip(): string[] {
  const { tabs, activeTabId } = useAppTabsStore.getState();
  return tabs.map((tab) => (tab.id === activeTabId ? `[${tab.href}]` : tab.href));
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  sessionStorage.clear();
});

describe('openTab', () => {
  it('inserts to the right of the active tab and focuses it', () => {
    setTabs(['/', '/agents'], 0);
    useAppTabsStore.getState().openTab('/tasks');
    expect(strip()).toEqual(['/', '[/tasks]', '/agents']);
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
    useAppTabsStore.getState().openTab('/agents');
    expect(strip()).toEqual(['[/agents]']);
  });
});

describe('closeTab', () => {
  it('refuses to close the last tab', () => {
    const [only] = setTabs(['/session?session=a']);
    useAppTabsStore.getState().closeTab(only.id);
    expect(strip()).toEqual(['[/session?session=a]']);
  });

  it('hands focus to the right-hand neighbour', () => {
    const tabs = setTabs(['/', '/agents', '/tasks'], 1);
    useAppTabsStore.getState().closeTab(tabs[1].id);
    expect(strip()).toEqual(['/', '[/tasks]']);
  });

  it('falls back to the left when the last tab closes', () => {
    const tabs = setTabs(['/', '/agents'], 1);
    useAppTabsStore.getState().closeTab(tabs[1].id);
    expect(strip()).toEqual(['[/]']);
  });

  it('leaves the active tab alone when a background tab closes', () => {
    const tabs = setTabs(['/', '/agents', '/tasks'], 2);
    useAppTabsStore.getState().closeTab(tabs[0].id);
    expect(strip()).toEqual(['/agents', '[/tasks]']);
  });

  it('ignores an id that names no tab', () => {
    setTabs(['/', '/agents'], 0);
    useAppTabsStore.getState().closeTab('nope');
    expect(strip()).toEqual(['[/]', '/agents']);
  });
});

describe('selectTab', () => {
  it('moves focus', () => {
    const tabs = setTabs(['/', '/agents'], 0);
    useAppTabsStore.getState().selectTab(tabs[1].id);
    expect(strip()).toEqual(['/', '[/agents]']);
  });

  it('ignores an id that names no tab', () => {
    setTabs(['/', '/agents'], 0);
    useAppTabsStore.getState().selectTab('nope');
    expect(strip()).toEqual(['[/]', '/agents']);
  });
});

describe('syncLocation — the URL is the active tab', () => {
  it('does nothing when the active tab is already there', () => {
    setTabs(['/', '/agents'], 1);
    const before = useAppTabsStore.getState().tabs;
    useAppTabsStore.getState().syncLocation('/agents');
    expect(useAppTabsStore.getState().tabs).toBe(before);
    expect(strip()).toEqual(['/', '[/agents]']);
  });

  it('re-activates the tab that already holds the location (Back after a tab switch)', () => {
    setTabs(['/session?session=a', '/session?session=b'], 1);
    useAppTabsStore.getState().syncLocation('/session?session=a');
    expect(strip()).toEqual(['[/session?session=a]', '/session?session=b']);
  });

  it('lets the active tab adopt a location no tab holds (navigating inside a tab)', () => {
    setTabs(['/', '/agents'], 1);
    useAppTabsStore.getState().syncLocation('/tasks');
    expect(strip()).toEqual(['/', '[/tasks]']);
  });

  it('lets a freshly opened tab adopt a route loader redirect', () => {
    // `openTab('/session?dir=/api')` lands on the session the loader picked.
    setTabs(['/'], 0);
    useAppTabsStore.getState().openTab('/session?dir=%2Fapi');
    useAppTabsStore.getState().syncLocation('/session?session=abc&dir=%2Fapi');
    expect(strip()).toEqual(['/', '[/session?session=abc&dir=%2Fapi]']);
  });

  it('keeps the active tab when two tabs share a location', () => {
    // Cmd+T twice leaves two dashboards; Back must not shuffle them.
    const tabs = setTabs(['/', '/'], 1);
    useAppTabsStore.getState().syncLocation('/');
    expect(useAppTabsStore.getState().activeTabId).toBe(tabs[1].id);
  });

  it('mints a tab when the window has none', () => {
    useAppTabsStore.setState({ tabs: [], activeTabId: null });
    useAppTabsStore.getState().syncLocation('/activity');
    expect(strip()).toEqual(['[/activity]']);
  });
});

describe('persistence', () => {
  it('writes through on every change and reads back', () => {
    setTabs(['/', '/agents'], 1);
    useAppTabsStore.getState().openTab('/tasks');
    const restored = readPersistedTabs();
    expect(restored?.tabs.map((tab) => tab.href)).toEqual(['/', '/agents', '/tasks']);
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
