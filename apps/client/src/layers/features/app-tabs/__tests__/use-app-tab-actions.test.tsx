/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useAppTabsStore, type AppTab } from '@/layers/shared/model';

const navigate = vi.fn();
let locationHref = '/';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { href: locationHref } }),
}));

import { useAppTabActions, NEW_TAB_HREF } from '../model/use-app-tab-actions';
import { useAppTabsSync } from '../model/use-app-tabs-sync';

function setTabs(hrefs: string[], activeIndex = 0): AppTab[] {
  const tabs = hrefs.map((href, index) => ({ id: `tab-${index}`, href }));
  useAppTabsStore.setState({ tabs, activeTabId: tabs[activeIndex]?.id ?? null });
  return tabs;
}

function activeHref(): string | undefined {
  const { tabs, activeTabId } = useAppTabsStore.getState();
  return tabs.find((tab) => tab.id === activeTabId)?.href;
}

beforeEach(() => {
  navigate.mockClear();
  locationHref = '/';
  sessionStorage.clear();
});

afterEach(cleanup);

describe('useAppTabActions', () => {
  it('activating a tab navigates to what that tab holds', () => {
    const tabs = setTabs(['/', '/session?session=abc'], 0);
    const { result } = renderHook(() => useAppTabActions());

    result.current.activate(tabs[1].id);

    expect(useAppTabsStore.getState().activeTabId).toBe(tabs[1].id);
    expect(navigate).toHaveBeenCalledWith({ href: '/session?session=abc' });
  });

  it('a new tab lands on the dashboard and takes focus', () => {
    setTabs(['/agents'], 0);
    const { result } = renderHook(() => useAppTabActions());

    result.current.create();

    expect(useAppTabsStore.getState().tabs.map((t) => t.href)).toEqual(['/agents', NEW_TAB_HREF]);
    expect(activeHref()).toBe(NEW_TAB_HREF);
    expect(navigate).toHaveBeenCalledWith({ href: NEW_TAB_HREF });
  });

  it('closing the tab you are on shows the one that took over', () => {
    const tabs = setTabs(['/', '/agents', '/tasks'], 1);
    const { result } = renderHook(() => useAppTabActions());

    result.current.close(tabs[1].id);

    expect(navigate).toHaveBeenCalledWith({ href: '/tasks' });
  });

  it('closing a background tab does not move you', () => {
    const tabs = setTabs(['/', '/agents'], 1);
    const { result } = renderHook(() => useAppTabActions());

    result.current.close(tabs[0].id);

    expect(navigate).toHaveBeenCalledWith({ href: '/agents' });
    expect(activeHref()).toBe('/agents');
  });

  it('closeActive is a no-op on the last tab, so the window can take Cmd+W', () => {
    setTabs(['/session?session=abc'], 0);
    const { result } = renderHook(() => useAppTabActions());

    result.current.closeActive();

    expect(useAppTabsStore.getState().tabs).toHaveLength(1);
  });

  it('indexes tabs from the left, and jumps to the last one', () => {
    setTabs(['/', '/agents', '/tasks'], 0);
    const { result } = renderHook(() => useAppTabActions());

    result.current.activateIndex(2);
    expect(activeHref()).toBe('/tasks');

    result.current.activateLast();
    expect(activeHref()).toBe('/tasks');

    result.current.activateIndex(99);
    expect(activeHref()).toBe('/tasks');
  });

  it('steps between tabs and wraps at both ends', () => {
    setTabs(['/', '/agents', '/tasks'], 0);
    const { result } = renderHook(() => useAppTabActions());

    result.current.activateRelative(-1);
    expect(activeHref()).toBe('/tasks');

    result.current.activateRelative(1);
    expect(activeHref()).toBe('/');
  });

  it('stepping does nothing with a single tab', () => {
    setTabs(['/'], 0);
    const { result } = renderHook(() => useAppTabActions());

    result.current.activateRelative(1);

    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('useAppTabsSync', () => {
  it('settles rather than ping-pongs after an action navigates', () => {
    const tabs = setTabs(['/', '/agents'], 0);
    const { result } = renderHook(() => useAppTabActions());
    result.current.activate(tabs[1].id);

    // The router lands where the action sent it.
    locationHref = '/agents';
    renderHook(() => useAppTabsSync());

    expect(useAppTabsStore.getState().activeTabId).toBe(tabs[1].id);
  });

  it('re-activates the tab holding the location the router moved to (Back)', () => {
    const tabs = setTabs(['/session?session=a', '/session?session=b'], 1);
    locationHref = '/session?session=a';

    renderHook(() => useAppTabsSync());

    expect(useAppTabsStore.getState().activeTabId).toBe(tabs[0].id);
  });

  it('lets the active tab adopt a location no tab holds', () => {
    setTabs(['/', '/agents'], 1);
    locationHref = '/tasks';

    renderHook(() => useAppTabsSync());

    expect(useAppTabsStore.getState().tabs.map((t) => t.href)).toEqual(['/', '/tasks']);
  });
});
