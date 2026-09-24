/**
 * Showcases for the Installed view's update states and the confirm step for
 * updates. Each state seeds its own `QueryClient` with the installed list
 * and the update check, so no section asks the server.
 *
 * @module dev/showcases/MarketplaceUpdateShowcases
 */
import { useState } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { IsolatedQueryProvider } from './marketplace-query-provider';

// The barrel first, then the leaves it does not carry — see the import rule in
// `.claude/skills/maintaining-dev-playground/SKILL.md`.
import { InstalledPackagesView } from '@/layers/features/marketplace';
import { ConfirmUpdatesDialog } from '@/layers/features/marketplace/ui/ConfirmUpdatesDialog';
import { indexChecks, summarizeUpdates } from '@/layers/features/marketplace/lib/installed-updates';
import { marketplaceKeys } from '@/layers/entities/marketplace';
import type { InstallationUpdateCheck } from '@dorkos/shared/marketplace-schemas';

import {
  MOCK_INSTALLED_FOR_UPDATES,
  MOCK_UPDATE_CHECKS,
  MOCK_UPDATE_CHECKS_ALL_CURRENT,
} from './marketplace-mocks';

/** Seed the installed list, then the check as given. */
function seedInstalled(qc: QueryClient) {
  qc.setQueryData(marketplaceKeys.installed(), MOCK_INSTALLED_FOR_UPDATES);
}

/** Seed a settled check. */
function seedChecks(checks: InstallationUpdateCheck[]) {
  return (qc: QueryClient) => {
    seedInstalled(qc);
    qc.setQueryData(marketplaceKeys.updates(), { checks });
  };
}

/** A check that never settles: the pending state, as when it waits behind another scan. */
function seedPendingCheck(qc: QueryClient) {
  seedInstalled(qc);
  void qc.prefetchQuery({
    queryKey: marketplaceKeys.updates(),
    queryFn: () => new Promise(() => {}),
  });
}

/** A check request that failed outright. */
function seedFailedCheck(qc: QueryClient) {
  seedInstalled(qc);
  void qc.prefetchQuery({
    queryKey: marketplaceKeys.updates(),
    queryFn: () => Promise.reject(new Error('Failed to fetch')),
  });
}

/** InstalledPackagesView in its empty state and in every update state. */
export function InstalledPackagesViewShowcase() {
  return (
    <PlaygroundSection
      title="InstalledPackagesView"
      description="Manage installed packages. One update check covers every installation: rows say whether an update is available (and to what), that they are up to date, or why they couldn't be checked; Update appears only where there is something to install."
    >
      <ShowcaseLabel>Empty state</ShowcaseLabel>
      <ShowcaseDemo>
        <IsolatedQueryProvider seed={(qc) => qc.setQueryData(marketplaceKeys.installed(), [])}>
          <InstalledPackagesView />
        </IsolatedQueryProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Updates available (one on an agent whose last attempt failed), current, and unknown
      </ShowcaseLabel>
      <ShowcaseDemo>
        <IsolatedQueryProvider seed={seedChecks(MOCK_UPDATE_CHECKS)}>
          <InstalledPackagesView />
        </IsolatedQueryProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>Everything up to date</ShowcaseLabel>
      <ShowcaseDemo>
        <IsolatedQueryProvider seed={seedChecks(MOCK_UPDATE_CHECKS_ALL_CURRENT)}>
          <InstalledPackagesView />
        </IsolatedQueryProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>Checking (pending, never shown as failed)</ShowcaseLabel>
      <ShowcaseDemo>
        <IsolatedQueryProvider seed={seedPendingCheck}>
          <InstalledPackagesView />
        </IsolatedQueryProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>The check request failed</ShowcaseLabel>
      <ShowcaseDemo>
        <IsolatedQueryProvider seed={seedFailedCheck}>
          <InstalledPackagesView />
        </IsolatedQueryProvider>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** The confirm step for updates, over the mock stale set or over just one of it. */
export function ConfirmUpdatesDialogShowcase() {
  const stale = summarizeUpdates(
    MOCK_INSTALLED_FOR_UPDATES,
    indexChecks(MOCK_UPDATE_CHECKS)
  ).available;
  const [open, setOpen] = useState<'all' | 'one' | null>(null);

  return (
    <PlaygroundSection
      title="ConfirmUpdatesDialog"
      description="Confirm step before updating: every installation it will touch, where it lives, its version change, and everything its new version runs on its own. Confirms any list, one included; a row whose new version runs something opens it too. A drawer on phones."
    >
      <ShowcaseDemo>
        <div className="flex gap-3">
          <button
            type="button"
            className="bg-card hover:bg-accent rounded-md border px-4 py-2 text-sm font-medium"
            onClick={() => setOpen('all')}
          >
            Open with {stale.length} stale installations →
          </button>
          <button
            type="button"
            className="bg-card hover:bg-accent rounded-md border px-4 py-2 text-sm font-medium"
            onClick={() => setOpen('one')}
          >
            Open with one →
          </button>
        </div>
        <ConfirmUpdatesDialog
          stale={open === 'all' ? stale : open === 'one' ? stale.slice(-1) : null}
          onCancel={() => setOpen(null)}
          onConfirm={() => setOpen(null)}
        />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
