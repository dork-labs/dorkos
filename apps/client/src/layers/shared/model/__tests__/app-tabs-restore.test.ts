/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  useAppTabsStore,
  readDesktopTabs,
  reopenTabIn,
  dropTabsIn,
  type AppTab,
  type AppTabsLayout,
} from '../app-tabs/app-tabs-store';

function tab(id: string, overrides: Partial<AppTab> = {}): AppTab {
  const href = overrides.href ?? `/${id}`;
  return { id, href, history: [href], cursor: 0, ...overrides };
}

function layout(tabs: AppTab[], activeTabId = tabs[0]?.id ?? null): AppTabsLayout {
  return { tabs, activeTabId };
}

/** Install a desktop bridge whose tab session answers `initial` and records saves. */
function installBridge(initial: unknown = null) {
  const save = vi.fn();
  window.electronAPI = {
    getServerPort: () => 4242,
    tabSession: { getInitial: () => initial, save },
  } as unknown as ElectronAPI;
  return save;
}

afterEach(() => {
  delete window.electronAPI;
  vi.useRealTimers();
});

describe('readDesktopTabs', () => {
  it('reads nothing outside the desktop app', () => {
    expect(readDesktopTabs()).toBeNull();
  });

  it('reads this window’s tabs from the shell, history and pin intact', () => {
    const saved = {
      tabs: [
        tab('b', { href: '/b', history: ['/a', '/b'], cursor: 1, pinned: true, lastViewedAt: 5 }),
      ],
      activeTabId: 'b',
    };
    installBridge(saved);
    expect(readDesktopTabs()).toEqual(saved);
  });

  it('repairs what the shell sent rather than trusting it', () => {
    installBridge({
      tabs: [
        tab('a'),
        { id: 'p', href: '/p', history: ['/p'], cursor: 0, pinned: true },
        { nope: 1 },
      ],
      activeTabId: 'gone',
    });
    // Pinned back in front, the junk dropped, the active id falls back.
    expect(readDesktopTabs()).toMatchObject({ activeTabId: 'p', tabs: [{ id: 'p' }, { id: 'a' }] });
  });

  it('reads nothing when the shell has nothing for this window, or the bridge throws', () => {
    installBridge(null);
    expect(readDesktopTabs()).toBeNull();
    window.electronAPI = {
      tabSession: {
        getInitial: () => {
          throw new Error('ipc down');
        },
      },
    } as unknown as ElectronAPI;
    expect(readDesktopTabs()).toBeNull();
  });
});

describe('saving to the shell', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000);
    useAppTabsStore.setState(layout([tab('a'), tab('b')], 'a'));
  });

  it('sends the whole tab list on every change, the front tab stamped as seen now', () => {
    const save = installBridge();
    vi.setSystemTime(2_000);
    useAppTabsStore.getState().moveTab(1, 0);
    expect(save).toHaveBeenLastCalledWith({
      activeTabId: 'a',
      tabs: [tab('b'), { ...tab('a'), lastViewedAt: 2_000 }],
    });
  });

  it('records the tab leaving the front as seen until the moment it left', () => {
    const save = installBridge();
    vi.setSystemTime(3_000);
    useAppTabsStore.getState().selectTab('b');
    vi.setSystemTime(9_000);
    useAppTabsStore.getState().moveTab(0, 1);
    const sent = save.mock.lastCall?.[0] as AppTabsLayout;
    expect(sent.tabs.find((t) => t.id === 'a')?.lastViewedAt).toBe(3_000);
    expect(sent.tabs.find((t) => t.id === 'b')?.lastViewedAt).toBe(9_000);
  });

  it('never changes a tab object just because it was looked at', () => {
    installBridge();
    const before = useAppTabsStore.getState().tabs;
    useAppTabsStore.getState().selectTab('b');
    expect(useAppTabsStore.getState().tabs).toBe(before);
  });
});

describe('reopenTabIn', () => {
  it('puts a closed tab back where it was, with its history, and focuses it', () => {
    const closed = tab('c', { href: '/c2', history: ['/c1', '/c2'], cursor: 1 });
    const next = reopenTabIn(layout([tab('a'), tab('b')]), closed, 1);
    expect(next.tabs.map((t) => t.id)).toEqual(['a', 'c', 'b']);
    expect(next.tabs[1]).toEqual(closed);
    expect(next.activeTabId).toBe('c');
  });

  it('keeps an unpinned tab out of the pinned run, and a pinned one in it', () => {
    const strip = layout([tab('p', { pinned: true }), tab('a')]);
    expect(reopenTabIn(strip, tab('x'), 0).tabs.map((t) => t.id)).toEqual(['p', 'x', 'a']);
    expect(reopenTabIn(strip, tab('y', { pinned: true }), 9).tabs.map((t) => t.id)).toEqual([
      'p',
      'y',
      'a',
    ]);
  });

  it('gives a fresh id to a tab whose id is already open', () => {
    const next = reopenTabIn(layout([tab('a')]), tab('a', { href: '/again' }), 1);
    expect(next.tabs).toHaveLength(2);
    expect(next.tabs[1].id).not.toBe('a');
  });

  it('changes nothing for something that is not a tab', () => {
    const strip = layout([tab('a')]);
    expect(reopenTabIn(strip, { href: 5 }, 0)).toBe(strip);
  });
});

describe('dropTabsIn', () => {
  it('drops the named tabs and keeps the front tab when it stays', () => {
    const next = dropTabsIn(layout([tab('a'), tab('b'), tab('c')], 'c'), new Set(['a']));
    expect(next).toEqual(layout([tab('b'), tab('c')], 'c'));
  });

  it('moves the front to the nearest survivor on its right when the front tab goes', () => {
    const next = dropTabsIn(
      layout([tab('a'), tab('b'), tab('c'), tab('d')], 'b'),
      new Set(['b', 'c'])
    );
    expect(next.activeTabId).toBe('d');
  });

  it('falls back to the last survivor when nothing is on the right', () => {
    const next = dropTabsIn(layout([tab('a'), tab('b')], 'b'), new Set(['b']));
    expect(next.activeTabId).toBe('a');
  });

  it('leaves one home tab rather than an empty strip', () => {
    const next = dropTabsIn(layout([tab('a')]), new Set(['a']));
    expect(next.tabs).toHaveLength(1);
    expect(next.tabs[0].href).toBe('/');
    expect(next.activeTabId).toBe(next.tabs[0].id);
  });

  it('changes nothing when no named tab is there', () => {
    const strip = layout([tab('a')]);
    expect(dropTabsIn(strip, new Set(['zzz']))).toBe(strip);
  });
});
