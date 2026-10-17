import { describe, it, expect } from 'vitest';
import {
  addRecentlyClosed,
  launchKindOf,
  planRestore,
  setAsideWindow,
  type RestoreContext,
} from '../restore-plan';
import {
  MAX_RECENTLY_CLOSED,
  STALE_TAB_MS,
  parseTabSessionFile,
  parseWindowTabs,
  type ClosedTab,
  type SavedTab,
  type WindowTabs,
} from '../schema';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function tab(id: string, overrides: Partial<SavedTab> = {}): SavedTab {
  const href = overrides.href ?? `/session?session=${id}`;
  return { id, href, history: [href], cursor: 0, lastViewedAt: NOW, ...overrides };
}

function win(tabs: SavedTab[], activeTabId = tabs[0]?.id ?? null): WindowTabs {
  return { tabs, activeTabId };
}

const normalReopen: RestoreContext = { kind: 'normal', startup: 'reopen', now: NOW };

describe('launchKindOf', () => {
  it('reads a clean quit as normal', () => {
    expect(launchKindOf({ cleanExit: true, relaunch: false })).toBe('normal');
  });

  it('reads a restart the app asked for as a relaunch', () => {
    expect(launchKindOf({ cleanExit: true, relaunch: true })).toBe('relaunch');
  });

  it('reads a run that never finished quitting (a crash) as a relaunch', () => {
    expect(launchKindOf({ cleanExit: false, relaunch: false })).toBe('relaunch');
  });
});

describe('planRestore — the decision table', () => {
  const stale = tab('old', { lastViewedAt: NOW - 8 * DAY });
  const pinnedStale = tab('pin', { pinned: true, lastViewedAt: NOW - 30 * DAY });
  const fresh = tab('new', { lastViewedAt: NOW - DAY });
  const saved = [win([pinnedStale, stale, fresh], 'old'), win([tab('second')])];

  it('restores everything after an app restart, whatever the setting and however old', () => {
    for (const startup of ['reopen', 'fresh'] as const) {
      const plan = planRestore(saved, { kind: 'relaunch', startup, now: NOW });
      expect(plan.windows).toEqual(saved);
      expect(plan.closed).toEqual([]);
    }
  });

  it('after a normal quit, reopens all but unpinned tabs unseen for over 7 days', () => {
    const plan = planRestore(saved, normalReopen);
    expect(plan.windows[0].tabs.map((t) => t.id)).toEqual(['pin', 'new']);
    expect(plan.windows[1].tabs.map((t) => t.id)).toEqual(['second']);
    // The stale tab is not lost: it goes to Recently closed, with its old place.
    expect(plan.closed).toEqual([{ tab: stale, index: 1, closedAt: NOW }]);
  });

  it('keeps a pinned tab however long it went unseen', () => {
    const plan = planRestore([win([pinnedStale])], normalReopen);
    expect(plan.windows[0].tabs).toEqual([pinnedStale]);
    expect(plan.closed).toEqual([]);
  });

  it('keeps a tab seen exactly 7 days ago, and lets one go a moment later', () => {
    const edge = tab('edge', { lastViewedAt: NOW - STALE_TAB_MS });
    const past = tab('past', { lastViewedAt: NOW - STALE_TAB_MS - 1 });
    const plan = planRestore([win([edge, past])], normalReopen);
    expect(plan.windows[0].tabs.map((t) => t.id)).toEqual(['edge']);
    expect(plan.closed.map((c) => c.tab.id)).toEqual(['past']);
  });

  it('treats a tab with no last-seen time (saved before stamping) as seen now', () => {
    const unstamped: SavedTab = { id: 'x', href: '/', history: ['/'], cursor: 0 };
    expect(planRestore([win([unstamped])], normalReopen).windows[0].tabs).toEqual([unstamped]);
  });

  it('hands the front to the most recently seen tab left when the front tab went stale', () => {
    const older = tab('older', { lastViewedAt: NOW - 3 * DAY });
    const newer = tab('newer', { lastViewedAt: NOW - DAY });
    const plan = planRestore([win([older, stale, newer], 'old')], normalReopen);
    expect(plan.windows[0].activeTabId).toBe('newer');
  });

  it('drops a window whose every tab went stale, and opens the rest', () => {
    const plan = planRestore([win([stale]), win([fresh])], normalReopen);
    expect(plan.windows).toEqual([win([fresh])]);
  });

  it('opens nothing (one home tab) when every window went stale', () => {
    expect(planRestore([win([stale])], normalReopen).windows).toEqual([]);
  });

  it('on Start fresh, opens nothing and files every tab, pinned ones too, under Recently closed', () => {
    const plan = planRestore(saved, { kind: 'normal', startup: 'fresh', now: NOW });
    expect(plan.windows).toEqual([]);
    expect(plan.closed.map((c) => c.tab.id)).toEqual(['old', 'pin', 'new', 'second']);
  });

  it('on Start fresh, puts the tab that was in front first, so Cmd+Shift+T brings it back', () => {
    const plan = planRestore([win([tab('a'), tab('b'), tab('c')], 'b')], {
      kind: 'normal',
      startup: 'fresh',
      now: NOW,
    });
    expect(plan.closed.map((c) => [c.tab.id, c.index])).toEqual([
      ['b', 1],
      ['a', 0],
      ['c', 2],
    ]);
  });

  it('has nothing to do on a first launch', () => {
    expect(planRestore([], normalReopen)).toEqual({ windows: [], closed: [] });
  });
});

describe('setAsideWindow', () => {
  it('keeps each tab whole — history, pin and all', () => {
    const rich = tab('r', { href: '/b', history: ['/a', '/b'], cursor: 1, pinned: true });
    expect(setAsideWindow(win([rich]), NOW)).toEqual([{ tab: rich, index: 0, closedAt: NOW }]);
  });
});

describe('addRecentlyClosed', () => {
  it('puts new entries first and keeps the newest 25', () => {
    const entry = (id: string): ClosedTab => ({ tab: tab(id), index: 0, closedAt: NOW });
    const full = Array.from({ length: MAX_RECENTLY_CLOSED }, (_, i) => entry(`old-${i}`));
    const next = addRecentlyClosed(full, [entry('new')]);
    expect(next).toHaveLength(MAX_RECENTLY_CLOSED);
    expect(next[0].tab.id).toBe('new');
    expect(next[next.length - 1].tab.id).toBe(`old-${MAX_RECENTLY_CLOSED - 2}`);
  });
});

describe('parseTabSessionFile — nothing unread is trusted', () => {
  const good = {
    version: 1,
    cleanExit: true,
    relaunch: false,
    startup: 'reopen',
    windows: [win([tab('a')])],
    recentlyClosed: [],
  };

  it('reads a well-formed file', () => {
    expect(parseTabSessionFile(good)).toEqual(good);
  });

  it('refuses a file from another version', () => {
    expect(parseTabSessionFile({ ...good, version: 2 })).toBeNull();
  });

  it('refuses a file of the wrong shape', () => {
    expect(parseTabSessionFile({ ...good, windows: 'lots' })).toBeNull();
    expect(parseTabSessionFile(null)).toBeNull();
    expect(parseTabSessionFile([])).toBeNull();
  });

  it('refuses a tab that points off the app (an absolute or protocol-relative URL)', () => {
    for (const href of ['https://evil.example', '//evil.example/x', 'javascript:alert(1)']) {
      const bad = { ...good, windows: [win([tab('a', { href, history: [href] })])] };
      expect(parseTabSessionFile(bad)).toBeNull();
    }
  });

  it('repairs a broken cursor and an active id that names no tab, keeping the tab', () => {
    const broken = {
      tabs: [{ ...tab('a'), cursor: 0, history: ['/elsewhere'] }],
      activeTabId: 'zzz',
    };
    const repaired = parseWindowTabs(broken);
    expect(repaired?.activeTabId).toBe('a');
    expect(repaired?.tabs[0]).toMatchObject({ history: ['/session?session=a'], cursor: 0 });
  });

  it('refuses a window with no tabs', () => {
    expect(parseWindowTabs({ tabs: [], activeTabId: null })).toBeNull();
  });
});
