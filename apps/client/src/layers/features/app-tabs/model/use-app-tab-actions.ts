/**
 * The four things a person can do to the tab strip, wired to the store and the
 * router in one place so the strip, the keyboard shortcuts, and the desktop
 * shell's Close Tab menu item all go through the same code.
 *
 * Every action follows the same order: change the tab set, then navigate to
 * whatever ended up active. The location change comes back through
 * `useAppTabsSync`, which finds the tab already sitting at that location and
 * agrees — so the round trip settles instead of ping-ponging.
 *
 * @module features/app-tabs/model/use-app-tab-actions
 */
import { useCallback, useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAppTabsStore } from '@/layers/shared/model';

/**
 * Where a brand-new tab lands: the dashboard, the cockpit's home. It is the one
 * route that is always safe to open, needs no arguments, and puts the whole
 * fleet in front of you — the natural place to pick what this tab becomes.
 * A fresh tab deliberately does not mint a session; "New session" already does.
 */
export const NEW_TAB_HREF = '/';

/** Everything the strip, the shortcuts, and the desktop menu can ask for. */
export interface AppTabActions {
  /** Bring a tab to the front by id. */
  activate: (id: string) => void;
  /** Bring the nth tab (0-based) to the front. Out-of-range does nothing. */
  activateIndex: (index: number) => void;
  /** Bring the rightmost tab to the front. */
  activateLast: () => void;
  /** Step `delta` tabs from the active one, wrapping at both ends. */
  activateRelative: (delta: number) => void;
  /** Close a tab by id. The last tab cannot be closed. */
  close: (id: string) => void;
  /** Close whichever tab is on screen. Does nothing when it is the last one. */
  closeActive: () => void;
  /** Open a new tab on {@link NEW_TAB_HREF} and focus it. */
  create: () => void;
}

/**
 * Tab actions bound to the router. Must be called inside the router (the
 * standalone cockpit's shell); the Obsidian embed mounts no strip.
 */
export function useAppTabActions(): AppTabActions {
  const navigate = useNavigate();

  // Reads the store imperatively rather than through selectors: these run in
  // event handlers, always want the state as of the click, and must read the
  // tab set AFTER their own mutation to know where to navigate.
  const goToActive = useCallback(() => {
    const { tabs, activeTabId } = useAppTabsStore.getState();
    const active = tabs.find((tab) => tab.id === activeTabId);
    if (active) void navigate({ href: active.href });
  }, [navigate]);

  return useMemo<AppTabActions>(() => {
    const activate = (id: string) => {
      useAppTabsStore.getState().selectTab(id);
      goToActive();
    };

    const activateIndex = (index: number) => {
      const { tabs } = useAppTabsStore.getState();
      const tab = tabs[index];
      if (tab) activate(tab.id);
    };

    return {
      activate,
      activateIndex,
      activateLast: () => activateIndex(useAppTabsStore.getState().tabs.length - 1),
      activateRelative: (delta) => {
        const { tabs, activeTabId } = useAppTabsStore.getState();
        if (tabs.length < 2) return;
        const current = tabs.findIndex((tab) => tab.id === activeTabId);
        const from = current === -1 ? 0 : current;
        // Modulo twice so a negative delta wraps to the end rather than to NaN.
        const next = (((from + delta) % tabs.length) + tabs.length) % tabs.length;
        activate(tabs[next].id);
      },
      close: (id) => {
        useAppTabsStore.getState().closeTab(id);
        goToActive();
      },
      closeActive: () => {
        const { activeTabId } = useAppTabsStore.getState();
        if (activeTabId) {
          useAppTabsStore.getState().closeTab(activeTabId);
          goToActive();
        }
      },
      create: () => {
        useAppTabsStore.getState().openTab(NEW_TAB_HREF);
        goToActive();
      },
    };
  }, [goToActive]);
}
