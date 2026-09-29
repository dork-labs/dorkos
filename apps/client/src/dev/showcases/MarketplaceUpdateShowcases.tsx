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
import {
  KeepFilesDialog,
  type UnprovenFiles,
} from '@/layers/features/marketplace/ui/KeepFilesDialog';
import { indexChecks, summarizeUpdates } from '@/layers/features/marketplace/lib/installed-updates';
import { marketplaceKeys } from '@/layers/entities/marketplace';
import type {
  HeldBackPackage,
  InstallationUpdateCheck,
  InstalledPackage,
} from '@dorkos/shared/marketplace-schemas';

import {
  MOCK_INSTALLED_FOR_UPDATES,
  MOCK_INSTALLED_VERIFIED,
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

/** A settled check plus verification: changed files on one row, an older install on another. */
function seedVerified(qc: QueryClient) {
  seedChecks(MOCK_UPDATE_CHECKS)(qc);
  qc.setQueryData(marketplaceKeys.integrity(), MOCK_INSTALLED_VERIFIED);
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

      <ShowcaseLabel>
        Files changed since install (open it for the paths, and what an update does to them), an
        install an older DorkOS made with Check files, one whose files were found to differ, and
        files an offline update kept because it couldn’t tell whose they were
      </ShowcaseLabel>
      <ShowcaseDemo>
        <IsolatedQueryProvider seed={seedVerified}>
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
          integrityByPath={
            new Map(
              MOCK_INSTALLED_VERIFIED.flatMap((pkg) =>
                pkg.integrity ? [[pkg.installPath, pkg.integrity] as const] : []
              )
            )
          }
          onCancel={() => setOpen(null)}
          onConfirm={() => setOpen(null)}
        />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** A global plugin installed from a folder, whose update kept files nothing can sort. */
const KEPT_INSTALLATION: InstalledPackage = {
  name: 'code-reviewer',
  version: '2.1.0',
  type: 'plugin',
  installPath: '/Users/kai/.dork/plugins/code-reviewer',
  installedFrom: '/Users/kai/dev/code-reviewer',
  scope: 'global',
};

/** Its kept files, as the Installed row lists them. */
const KEPT_FILES: UnprovenFiles = {
  files: ['commands/old-review.md', 'notes/team-style.md', 'prompts/review.md.dork-old'],
  running: ['commands/old-review.md'],
  check: { source: 'local' },
  keepKey: 'sha256:kept',
};

/** What the held-back listing says the package runs. */
const KEPT_HELD_BACK: HeldBackPackage = {
  name: 'code-reviewer',
  reason: 'unasked',
  reviewable: true,
  note: 'Held back: 1 file an update kept still runs. Review it to decide.',
  changedSinceApproval: true,
  bindsTo: 'sha256:pkg',
  effects: {
    hooks: [
      {
        event: 'PostToolUse',
        matcher: 'Edit|Write',
        command: '${CLAUDE_PLUGIN_ROOT}/bin/lint-changed.sh',
        source: null,
      },
    ],
    schedules: [],
    mcpServers: [],
    lspServers: [],
    monitors: [],
    executables: ['bin/lint-changed.sh'],
    skillTools: [],
    skillCommands: [],
  },
};

/** The confirm step for "Keep these as mine" (DOR-2341), plain and for a held-back global package. */
export function KeepFilesDialogShowcase() {
  const [open, setOpen] = useState<'plain' | 'held' | null>(null);
  return (
    <PlaygroundSection
      title="KeepFilesDialog"
      description="Confirm step for Keep these as mine: the files an update kept but nothing can sort, the ones that still run listed apart, and a plain promise that nothing moves or is deleted. For a global package held back from sessions it also shows everything the package runs, and confirming approves what it discloses now, like a Review. Offered only where Check files can't sort the files."
    >
      <ShowcaseDemo>
        <div className="flex gap-3">
          <button
            type="button"
            className="bg-card hover:bg-accent rounded-md border px-4 py-2 text-sm font-medium"
            onClick={() => setOpen('plain')}
          >
            Open for a package that loads →
          </button>
          <button
            type="button"
            className="bg-card hover:bg-accent rounded-md border px-4 py-2 text-sm font-medium"
            onClick={() => setOpen('held')}
          >
            Open for a held-back package →
          </button>
        </div>
        <IsolatedQueryProvider
          seed={(qc) => qc.setQueryData(marketplaceKeys.heldBack(), [KEPT_HELD_BACK])}
        >
          <KeepFilesDialog
            installation={
              open === 'plain'
                ? KEPT_INSTALLATION
                : open === 'held'
                  ? {
                      ...KEPT_INSTALLATION,
                      heldBack: {
                        reason: 'unasked',
                        reviewable: true,
                        note: KEPT_HELD_BACK.note,
                      },
                    }
                  : null
            }
            unproven={KEPT_FILES}
            onCancel={() => setOpen(null)}
            onConfirm={() => setOpen(null)}
          />
        </IsolatedQueryProvider>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
