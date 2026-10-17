/**
 * Drop restored tabs whose chat or room is gone, quietly, once per window load.
 *
 * A remembered tab can outlive its page: a chat deleted from another device, a
 * room left while DorkOS was closed. Showing one as an error page the moment
 * the app opens would greet the person with something broken they did not
 * ask for. So the tabs this window opened with are checked once
 * (`findMissingTabs`), and any the server definitely no longer has are removed
 * without a word and without going to Recently closed, since there is nothing
 * left to reopen. When the tab in front was one of them, the window moves to
 * the tab that takes its place.
 *
 * **Desktop shell only**, like the tabs. Mounted once, by the shell.
 *
 * @module features/app-tabs/model/use-prune-missing-tabs
 */
import { useEffect } from 'react';
import { useRouter } from '@tanstack/react-router';
import { isDesktopShell } from '@/layers/shared/lib';
import { useAppTabsStore, useTransport } from '@/layers/shared/model';
import { findMissingTabs } from '../lib/missing-tabs';
import { goToActiveTab } from './tab-navigation';

/** Check this window's opening tabs once, and drop the ones that are gone. */
export function usePruneMissingTabs(): void {
  const transport = useTransport();
  const router = useRouter();

  useEffect(() => {
    if (!isDesktopShell()) return;
    let cancelled = false;
    // The tabs as the window opened: the ones a restore brought back. A tab
    // opened after this point was opened on something that exists.
    const opening = useAppTabsStore.getState().tabs;
    void findMissingTabs(opening, {
      getSession: (id) => transport.getSession(id),
      getRoom: (id) => transport.getRoom(id),
    })
      .then((missing) => {
        if (cancelled || missing.size === 0) return;
        const before = useAppTabsStore.getState().activeTabId;
        useAppTabsStore.getState().dropTabs(missing);
        if (useAppTabsStore.getState().activeTabId !== before) goToActiveTab(router);
      })
      .catch((error: unknown) => {
        console.error('[dorkos:tabs] could not check restored tabs', error);
      });
    return () => {
      cancelled = true;
    };
    // Once per window load, on purpose: see the module doc.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
