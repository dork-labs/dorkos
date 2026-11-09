/**
 * Seed the Apps door's pins once, from what the old Add-ons section listed
 * (DOR-3970), so nobody loses the apps they had in the sidebar.
 *
 * **Client-side on purpose.** Only the client knows which extensions add
 * pages, so no server migration can do this. `ui.sidebar.pinnedApps` absent
 * means "never seeded"; this writes it the first time apps are known, and
 * never again — an emptied list stays empty.
 *
 * In its own module for the reason `use-legacy-pin-migration` is: the panel's
 * root component is held to "transforms nothing" by a source-level test.
 *
 * @module features/dashboard-sidebar/model/use-app-pin-seed
 */
import { useEffect, useRef } from 'react';
import { MAX_PINNED_APPS } from '@dorkos/shared/config-schema';
import { useConfig, useSidebarPrefs } from '@/layers/entities/config';
import { useAppCatalog, useAppPins } from '@/layers/entities/extension';

/**
 * Write the first pins once: the running apps that added a page, in the order
 * Add-ons listed them (A–Z), up to {@link MAX_PINNED_APPS}.
 *
 * Waits for real config and for at least one running app, so a first paint
 * before the extensions load cannot seed an empty list and lose them.
 */
export function useAppPinSeed(): void {
  const { data: config } = useConfig();
  const stored = useSidebarPrefs().pinnedApps;
  const catalog = useAppCatalog();
  const { setPins } = useAppPins();
  const doneRef = useRef(false);

  useEffect(() => {
    if (doneRef.current || config === undefined) return;
    if (stored !== undefined) {
      doneRef.current = true;
      return;
    }
    if (catalog.status !== 'ready') return;
    const running = catalog.apps.filter((app) => app.pageId !== null && app.state === 'ok');
    if (running.length === 0) return;
    doneRef.current = true;
    setPins(running.slice(0, MAX_PINNED_APPS).map((app) => app.id));
  }, [catalog, config, setPins, stored]);
}
