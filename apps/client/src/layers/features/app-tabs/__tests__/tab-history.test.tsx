/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';
import { useAppTabsStore, type AppTab } from '@/layers/shared/model';
import { enterDesktopShell, leaveDesktopShell } from '@/test-helpers/desktop-shell';

type HistoryActionType = 'PUSH' | 'REPLACE' | 'GO' | 'FORWARD' | 'BACK';

const historySubscribers = new Set<(opts: { action: { type: HistoryActionType } }) => void>();
let locationHref = '/';
/** Re-renders the mounted `useAppTabsSync`, as a committed location change would. */
let rerenderSync = () => {};
/** Hrefs whose route loader redirects elsewhere, as `/session?dir=…` does. */
let redirects: Record<string, string> = {};

/** Commit one location change the way the router does: notify, then render. */
function commit(href: string, type: HistoryActionType) {
  act(() => {
    for (const subscriber of historySubscribers) subscriber({ action: { type } });
    locationHref = href;
    rerenderSync();
  });
}

// A router that really moves: each navigation is a PUSH through the sync hook,
// and a redirecting href is followed by the REPLACE the router reports for it.
const navigate = vi.fn(async ({ href }: { href: string }) => {
  if (href !== locationHref) commit(href, 'PUSH');
  const redirect = redirects[href];
  if (redirect) commit(redirect, 'REPLACE');
});

const router = {
  navigate: (options: { href: string }) => navigate(options),
  get state() {
    return { location: { href: locationHref } };
  },
  history: {
    subscribe: (cb: (opts: { action: { type: HistoryActionType } }) => void) => {
      historySubscribers.add(cb);
      return () => historySubscribers.delete(cb);
    },
  },
};

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => router,
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { href: locationHref } }),
}));

import { useAppTabsSync } from '../model/use-app-tabs-sync';
import { goBack, goForward, goToHistoryEntry } from '../model/tab-history';

/** One tab whose history is `hrefs`, sitting at `cursor`, with the router there too. */
function setHistory(hrefs: string[], cursor = hrefs.length - 1): AppTab {
  const tab = { id: 'tab-0', href: hrefs[cursor], history: hrefs, cursor };
  useAppTabsStore.setState({ tabs: [tab], activeTabId: tab.id });
  locationHref = tab.href;
  const { rerender } = renderHook(() => useAppTabsSync());
  rerenderSync = rerender;
  return tab;
}

/** The active tab's history with the current entry marked. */
function trail(): string[] {
  const { tabs, activeTabId } = useAppTabsStore.getState();
  const tab = tabs.find((t) => t.id === activeTabId)!;
  return tab.history.map((href, index) => (index === tab.cursor ? `[${href}]` : href));
}

/** Let the post-navigation reconcile in `goToActiveTab` run. */
async function settle() {
  await act(async () => {});
}

beforeEach(() => {
  navigate.mockClear();
  historySubscribers.clear();
  redirects = {};
  sessionStorage.clear();
  enterDesktopShell();
});

afterEach(() => {
  cleanup();
  leaveDesktopShell();
});

describe('goBack / goForward', () => {
  it('goes back one page and records nothing new once the navigation lands', async () => {
    // Purpose: the store moves first, so the sync that follows hits rule 1.
    setHistory(['/', '/team', '/tasks']);
    goBack(router);
    await settle();
    expect(navigate).toHaveBeenCalledWith({ href: '/team' });
    expect(locationHref).toBe('/team');
    expect(trail()).toEqual(['/', '[/team]', '/tasks']);
  });

  it('goes forward again the same way', async () => {
    // Purpose: Forward is the mirror of Back and keeps the stack intact.
    setHistory(['/', '/team', '/tasks'], 0);
    goForward(router);
    await settle();
    expect(locationHref).toBe('/team');
    expect(trail()).toEqual(['/', '[/team]', '/tasks']);
  });

  it('does nothing at either end — not even a navigation', () => {
    // Purpose: Back on the first page must not reload it.
    setHistory(['/', '/team'], 0);
    goBack(router);
    useAppTabsStore.getState().goToHistoryIndex(1);
    goForward(router);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('goToHistoryEntry', () => {
  it('jumps to any entry and keeps Forward available', async () => {
    // Purpose: the History menu's jump is a cursor move, not a new page.
    setHistory(['/', '/team', '/tasks', '/activity']);
    goToHistoryEntry(router, 1);
    await settle();
    expect(locationHref).toBe('/team');
    expect(trail()).toEqual(['/', '[/team]', '/tasks', '/activity']);
  });

  it('lets a loader redirect rewrite the jumped-to entry in place', async () => {
    // Purpose: a REPLACE after a jump rewrites that entry; Forward survives.
    setHistory(['/', '/session?dir=%2Fapi', '/team']);
    redirects['/session?dir=%2Fapi'] = '/session?session=abc&dir=%2Fapi';
    goToHistoryEntry(router, 1);
    await settle();
    expect(trail()).toEqual(['/', '[/session?session=abc&dir=%2Fapi]', '/team']);
  });

  it('rewrites the entry when the redirect lands where the router already was', async () => {
    // Purpose: no location change fires here, so only the post-navigation
    // reconcile sees the redirect — and it must replace, not push, or the
    // jump would leave the transient href behind. The rewritten entry now
    // equals the one after it, so the two fold into one.
    const resolved = '/session?session=abc&dir=%2Fapi';
    setHistory(['/', '/team', '/session?dir=%2Fapi', resolved]);
    redirects['/session?dir=%2Fapi'] = resolved;
    navigate.mockImplementationOnce(async () => {});
    goToHistoryEntry(router, 2);
    await settle();
    expect(trail()).toEqual(['/', '/team', `[${resolved}]`]);
  });

  it('leaves the store alone if you moved on before the navigation settled', async () => {
    // Purpose: the post-navigation reconcile is for the tab and page it was
    // started for; a later tab switch must not get that location written over it.
    const a = { id: 'a', href: '/team', history: ['/', '/team'], cursor: 1 };
    const b = { id: 'b', href: '/tasks', history: ['/tasks'], cursor: 0 };
    useAppTabsStore.setState({ tabs: [a, b], activeTabId: 'a' });
    locationHref = '/team';
    let settleNavigation = () => {};
    navigate.mockImplementationOnce(
      () => new Promise<void>((resolve) => (settleNavigation = resolve))
    );

    goBack(router);
    act(() => useAppTabsStore.getState().selectTab('b'));
    await act(async () => settleNavigation());

    const tabs = useAppTabsStore.getState().tabs;
    expect(tabs[1]).toEqual(b);
    expect(tabs[0]).toMatchObject({ href: '/', cursor: 0, history: ['/', '/team'] });
  });
});

describe('useAppTabsSync — how the location changed decides how history records it', () => {
  it('passes a REPLACE through as a rewrite of the current entry', () => {
    // Purpose: a search-param update or redirect must not grow the Back stack.
    setHistory(['/', '/session?dir=%2Fapi']);
    commit('/session?session=abc&dir=%2Fapi', 'REPLACE');
    expect(trail()).toEqual(['/', '[/session?session=abc&dir=%2Fapi]']);
  });

  it('passes a PUSH through as a new entry', () => {
    // Purpose: ordinary navigation is what fills the Back stack.
    setHistory(['/']);
    commit('/team', 'PUSH');
    expect(trail()).toEqual(['/', '[/team]']);
  });

  it('does not let a REPLACE that changed nothing leak into the next PUSH', () => {
    // Purpose: the flag is assigned per notification, never left stale.
    setHistory(['/', '/team']);
    act(() => {
      for (const subscriber of historySubscribers) subscriber({ action: { type: 'REPLACE' } });
    });
    commit('/tasks', 'PUSH');
    expect(trail()).toEqual(['/', '/team', '[/tasks]']);
  });

  it('treats a redirect that landed before it subscribed as a replace', () => {
    // Purpose: on first paint a loader can redirect before the history
    // listener attaches; that is the same page, not a new entry.
    const tab = {
      id: 'tab-0',
      href: '/session?dir=%2Fapi',
      history: ['/', '/session?dir=%2Fapi'],
      cursor: 1,
    };
    useAppTabsStore.setState({ tabs: [tab], activeTabId: tab.id });
    locationHref = '/session?session=abc&dir=%2Fapi';
    renderHook(() => useAppTabsSync());
    expect(trail()).toEqual(['/', '[/session?session=abc&dir=%2Fapi]']);
  });

  it('still treats a traversal as focus-only, recording nothing', () => {
    // Purpose: rule 2 is unchanged by per-tab history.
    const a = { id: 'a', href: '/', history: ['/'], cursor: 0 };
    const b = { id: 'b', href: '/team', history: ['/team'], cursor: 0 };
    useAppTabsStore.setState({ tabs: [a, b], activeTabId: 'b' });
    locationHref = '/team';
    rerenderSync = renderHook(() => useAppTabsSync()).rerender;
    commit('/', 'BACK');
    const state = useAppTabsStore.getState();
    expect(state.activeTabId).toBe('a');
    expect(state.tabs).toEqual([a, b]);
  });
});
