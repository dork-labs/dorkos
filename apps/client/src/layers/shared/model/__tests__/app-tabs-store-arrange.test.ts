/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useAppTabsStore, readPersistedTabs, type AppTab } from '../app-tabs/app-tabs-store';

const STORAGE_KEY = 'dork.app-tabs';

/** Seed the store with tabs named by their href; a trailing `*` pins one. */
function setTabs(specs: string[], activeIndex = 0): void {
  const tabs: AppTab[] = specs.map((spec, index) => {
    const pinned = spec.endsWith('*');
    const href = pinned ? spec.slice(0, -1) : spec;
    return { id: `tab-${index}`, href, history: [href], cursor: 0, ...(pinned && { pinned }) };
  });
  useAppTabsStore.setState({ tabs, activeTabId: tabs[activeIndex]?.id ?? null });
}

/** The strip as a person sees it: pinned tabs marked `*`, the active one bracketed. */
function strip(): string[] {
  const { tabs, activeTabId } = useAppTabsStore.getState();
  return tabs.map((tab) => {
    const name = `${tab.href}${tab.pinned ? '*' : ''}`;
    return tab.id === activeTabId ? `[${name}]` : name;
  });
}

/** The id of the tab at `href`, so actions can be called by what a person sees. */
function idOf(href: string): string {
  const tab = useAppTabsStore.getState().tabs.find((t) => t.href === href);
  if (!tab) throw new Error(`no tab at ${href}`);
  return tab.id;
}

/** Pinned tabs always lead — the order invariant every action keeps. */
function expectPinnedFirst(): void {
  const { tabs } = useAppTabsStore.getState();
  const firstUnpinned = tabs.findIndex((tab) => !tab.pinned);
  if (firstUnpinned === -1) return;
  expect(tabs.slice(firstUnpinned).some((tab) => tab.pinned)).toBe(false);
}

const store = () => useAppTabsStore.getState();

beforeEach(() => sessionStorage.clear());
afterEach(() => sessionStorage.clear());

describe('setTabPinned', () => {
  it('moves a pinned tab to the end of the pinned run', () => {
    setTabs(['/a*', '/b', '/c', '/d'], 0);
    store().setTabPinned(idOf('/c'), true);
    expect(strip()).toEqual(['[/a*]', '/c*', '/b', '/d']);
  });

  it('moves an unpinned tab to the start of the unpinned tabs', () => {
    setTabs(['/a*', '/b*', '/c*', '/d'], 3);
    store().setTabPinned(idOf('/a'), false);
    expect(strip()).toEqual(['/b*', '/c*', '/a', '[/d]']);
  });

  it('drops the field rather than storing false, so unpinned reads like an old tab', () => {
    setTabs(['/a*', '/b']);
    store().setTabPinned(idOf('/a'), false);
    expect(store().tabs[0]).not.toHaveProperty('pinned');
  });

  it('changes nothing for a tab already in that state, or an unknown id', () => {
    setTabs(['/a*', '/b']);
    const before = store().tabs;
    store().setTabPinned(idOf('/a'), true);
    store().setTabPinned(idOf('/b'), false);
    store().setTabPinned('nope', true);
    expect(store().tabs).toBe(before);
  });

  it('keeps which tab is active', () => {
    setTabs(['/a', '/b', '/c'], 1);
    store().setTabPinned(idOf('/c'), true);
    expect(strip()).toEqual(['/c*', '/a', '[/b]']);
  });
});

describe('duplicateTab', () => {
  it('opens a copy right after the tab, makes it active, and starts its history fresh', () => {
    useAppTabsStore.setState({
      tabs: [
        { id: 'a', href: '/x', history: ['/', '/x', '/y'], cursor: 1 },
        { id: 'b', href: '/b', history: ['/b'], cursor: 0 },
      ],
      activeTabId: 'b',
    });
    store().duplicateTab('a');
    const { tabs, activeTabId } = store();
    expect(tabs.map((t) => t.href)).toEqual(['/x', '/x', '/b']);
    expect(activeTabId).toBe(tabs[1].id);
    expect(tabs[1].id).not.toBe('a');
    expect(tabs[1].history).toEqual(['/x']);
    expect(tabs[1].cursor).toBe(0);
  });

  it('keeps a pinned copy pinned, so it stays beside its original', () => {
    setTabs(['/a*', '/b*', '/c']);
    store().duplicateTab(idOf('/a'));
    expect(strip()).toEqual(['/a*', '[/a*]', '/b*', '/c']);
    expectPinnedFirst();
  });

  it('ignores an unknown id', () => {
    setTabs(['/a']);
    const before = store().tabs;
    store().duplicateTab('nope');
    expect(store().tabs).toBe(before);
  });
});

describe('closeOtherTabs', () => {
  it('closes every other unpinned tab, keeps pinned ones, and activates the kept tab', () => {
    setTabs(['/p*', '/a', '/b', '/c'], 3);
    store().closeOtherTabs(idOf('/b'));
    expect(strip()).toEqual(['/p*', '[/b]']);
  });

  it('from a pinned tab, closes every unpinned tab', () => {
    setTabs(['/p*', '/q*', '/a', '/b'], 2);
    store().closeOtherTabs(idOf('/q'));
    expect(strip()).toEqual(['/p*', '[/q*]']);
  });

  it('changes nothing when there is nothing to close and the tab is already active', () => {
    setTabs(['/p*', '/a'], 1);
    const before = store().tabs;
    store().closeOtherTabs(idOf('/a'));
    expect(store().tabs).toBe(before);
  });

  it('ignores an unknown id', () => {
    setTabs(['/a', '/b']);
    store().closeOtherTabs('nope');
    expect(strip()).toEqual(['[/a]', '/b']);
  });
});

describe('moveTab', () => {
  it('moves a tab right and left, shifting the tabs between', () => {
    setTabs(['/a', '/b', '/c', '/d']);
    store().moveTab(0, 2);
    expect(strip()).toEqual(['/b', '/c', '[/a]', '/d']);
    store().moveTab(3, 0);
    expect(strip()).toEqual(['/d', '/b', '/c', '[/a]']);
  });

  it('holds an unpinned tab right of the pinned ones', () => {
    setTabs(['/p*', '/q*', '/a', '/b']);
    store().moveTab(3, 0);
    expect(strip()).toEqual(['[/p*]', '/q*', '/b', '/a']);
    expectPinnedFirst();
  });

  it('holds a pinned tab left of the unpinned ones', () => {
    setTabs(['/p*', '/q*', '/a', '/b']);
    store().moveTab(0, 3);
    expect(strip()).toEqual(['/q*', '[/p*]', '/a', '/b']);
    expectPinnedFirst();
  });

  it('changes nothing for an out-of-range source or a move to where it is', () => {
    setTabs(['/a', '/b']);
    const before = store().tabs;
    store().moveTab(5, 0);
    store().moveTab(1, 1);
    store().moveTab(1, 9); // clamps to 1, its own place
    expect(store().tabs).toBe(before);
  });
});

describe('openTab beside pinned tabs', () => {
  it('opens first among the unpinned tabs when a pinned tab is active', () => {
    setTabs(['/p*', '/q*', '/a'], 0);
    store().openTab('/new');
    expect(strip()).toEqual(['/p*', '/q*', '[/new]', '/a']);
  });

  it('still opens right of an active unpinned tab', () => {
    setTabs(['/p*', '/a', '/b'], 1);
    store().openTab('/new');
    expect(strip()).toEqual(['/p*', '/a', '[/new]', '/b']);
  });
});

describe('persistence of pinned', () => {
  it('writes pinned through and reads it back', () => {
    setTabs(['/a', '/b']);
    store().setTabPinned(idOf('/b'), true);
    const restored = readPersistedTabs();
    expect(restored?.tabs.map((t) => [t.href, t.pinned])).toEqual([
      ['/b', true],
      ['/a', undefined],
    ]);
  });

  it('reads tabs saved before pinning existed as unpinned', () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        tabs: [
          { id: 'a', href: '/a', history: ['/a'], cursor: 0 },
          { id: 'b', href: '/b' },
        ],
        activeTabId: 'b',
      })
    );
    const restored = readPersistedTabs();
    expect(restored?.tabs.map((t) => t.pinned)).toEqual([undefined, undefined]);
    expect(restored?.activeTabId).toBe('b');
  });

  it('only a literal true pins, and pinned tabs are put back in front', () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        tabs: [
          { id: 'a', href: '/a', history: ['/a'], cursor: 0, pinned: 'yes' },
          { id: 'b', href: '/b', history: ['/b'], cursor: 0, pinned: true },
          { id: 'c', href: '/c', history: ['/c'], cursor: 0, pinned: false },
        ],
        activeTabId: 'a',
      })
    );
    const restored = readPersistedTabs();
    expect(restored?.tabs.map((t) => [t.id, t.pinned ?? false])).toEqual([
      ['b', true],
      ['a', false],
      ['c', false],
    ]);
  });
});

describe('order invariant under random arranging', () => {
  it('keeps pinned tabs first through any mix of actions', () => {
    setTabs(['/0', '/1', '/2', '/3', '/4']);
    // A small deterministic generator, so a failure replays exactly.
    let seed = 7;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let step = 0; step < 300; step += 1) {
      const { tabs } = store();
      const pick = tabs[next(tabs.length)];
      switch (next(5)) {
        case 0:
          store().setTabPinned(pick.id, !pick.pinned);
          break;
        case 1:
          if (tabs.length < 9) store().duplicateTab(pick.id);
          break;
        case 2:
          store().moveTab(next(tabs.length), next(tabs.length));
          break;
        case 3:
          if (tabs.length < 9) store().openTab(`/n${step}`);
          break;
        case 4:
          if (tabs.length > 6) store().closeOtherTabs(pick.id);
          break;
      }
      expectPinnedFirst();
      expect(store().tabs.some((t) => t.id === store().activeTabId)).toBe(true);
    }
  });
});
