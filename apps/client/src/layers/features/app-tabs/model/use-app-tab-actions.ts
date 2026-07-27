/**
 * The four things a person can do to the tab strip, wired to the store and the
 * router in one place so the strip, the keyboard shortcuts, and the desktop
 * shell's Close Tab menu item all go through the same code.
 *
 * Every action follows the same order: change the tab set, then navigate to
 * whatever ended up active. The location change comes back through
 * `useAppTabsSync`, which finds the tab already sitting at that location and
 * agrees — so the round trip settles instead of ping-ponging. When the router
 * resolves somewhere other than we asked and that somewhere is where it already
 * was, no location change fires at all, so {@link useAppTabActions} closes the
 * loop itself once the navigation settles. Both paths call the same
 * `syncLocation`: one rule, two triggers.
 *
 * @module features/app-tabs/model/use-app-tab-actions
 */
import { useMemo } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useAppTabsStore } from '@/layers/shared/model';
import { goToActiveTab, openTabAt } from './tab-navigation';

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
  /**
   * Close whichever tab is on screen, and report whether there was one to
   * close. `false` on the last tab, which is what the desktop shell's
   * `Cmd/Ctrl+W` contract needs to hear before it closes the window. Answers
   * synchronously — the shell races the reply.
   */
  closeActive: () => boolean;
  /** Open a new tab on {@link NEW_TAB_HREF} and focus it. */
  create: () => void;
}

/**
 * Tab actions bound to the router. Must be called inside the router (the
 * standalone cockpit's shell); the Obsidian embed mounts no strip.
 */
export function useAppTabActions(): AppTabActions {
  const router = useRouter();

  return useMemo<AppTabActions>(() => {
    // Reads the store imperatively rather than through selectors: these run in
    // event handlers, always want the state as of the click, and must read the
    // tab set AFTER their own mutation to know where to navigate.
    const goToActive = () => goToActiveTab(router);

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
        const { tabs, activeTabId } = useAppTabsStore.getState();
        if (!activeTabId) return false;
        const before = tabs.length;
        useAppTabsStore.getState().closeTab(activeTabId);
        // `closeTab` refuses the last tab, so the count is the honest answer to
        // "did anything close?" — never the caller's own guess at the rule.
        const closed = useAppTabsStore.getState().tabs.length < before;
        if (closed) goToActive();
        return closed;
      },
      create: () => openTabAt(router, NEW_TAB_HREF),
    };
  }, [router]);
}
