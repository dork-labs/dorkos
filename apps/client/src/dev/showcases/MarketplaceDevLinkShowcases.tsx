/**
 * Showcases for dev links (DOR-2696): the Installed rows in each state, the
 * tag and path line, and the unlink dialog. Each state seeds its own
 * `QueryClient`, so no section asks the server.
 *
 * @module dev/showcases/MarketplaceDevLinkShowcases
 */
import { useState } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { IsolatedQueryProvider } from './marketplace-query-provider';

// The barrel first, then the leaves it does not carry — see the import rule in
// `.claude/skills/maintaining-dev-playground/SKILL.md`.
import { InstalledPackagesView, UnlinkDialog, type UnlinkTarget } from '@/layers/features/marketplace';
import { marketplaceKeys, useDevLinkReloadStore } from '@/layers/entities/marketplace';
import { Button, DevLinkPath, DevLinkTag } from '@/layers/shared/ui';

import {
  MOCK_DEV_LINKED_INSTALLED,
  MOCK_PACKAGES,
  mockDevLinkListing,
  mockFailedReload,
} from './marketplace-mocks';

/** Seed the dev-linked rows, their listing, the catalog, and one failed reload. */
function seedDevLinks(qc: QueryClient) {
  const now = Date.now();
  qc.setQueryData(marketplaceKeys.installed(), MOCK_DEV_LINKED_INSTALLED);
  qc.setQueryData(marketplaceKeys.devLinks(), mockDevLinkListing(now));
  qc.setQueryData(marketplaceKeys.updates(), { checks: [] });
  qc.setQueryData(marketplaceKeys.packageList(undefined), [
    ...MOCK_PACKAGES,
    { name: 'release-notes', source: 'github.com/kai/release-notes', marketplace: 'dorkos-community' },
  ]);
  useDevLinkReloadStore.getState().record(mockFailedReload(now));
}

/** The record file of dev links can't be read. */
function seedUnreadable(qc: QueryClient) {
  qc.setQueryData(marketplaceKeys.installed(), []);
  qc.setQueryData(marketplaceKeys.devLinks(), {
    links: [],
    registryUnreadable: '/Users/kai/.dork/marketplace/dev-links.json',
  });
}

/** The unlink dialog, for a link with and without an installed copy set aside. */
function UnlinkDialogDemo() {
  const [target, setTarget] = useState<UnlinkTarget | null>(null);
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="outline"
        onClick={() => setTarget({ name: 'flow', scope: 'global', parked: true })}
      >
        Installed copy set aside
      </Button>
      <Button
        variant="outline"
        onClick={() => setTarget({ name: 'release-notes', scope: 'global', parked: false })}
      >
        Nothing set aside
      </Button>
      <Button
        variant="outline"
        onClick={() =>
          setTarget({ name: 'release-notes', scope: 'global', parked: false, then: 'install' })
        }
      >
        Install published version
      </Button>
      <UnlinkDialog target={target} onClose={() => setTarget(null)} />
    </div>
  );
}

/** Dev links in the Installed view, the tag and path line, and the unlink dialog. */
export function DevLinkShowcase() {
  return (
    <PlaygroundSection
      title="Dev links"
      description="A package running straight from a folder on this computer. Rows show the folder, when it last reloaded, and switches instead of Update and Uninstall."
    >
      <ShowcaseLabel>Tag and path line (narrow width wraps the path)</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="max-w-xs space-y-1.5">
          <DevLinkTag />
          <DevLinkPath path="/Users/kai/Keep/dork-os/marketplace/plugins/flow-with-a-long-folder-name" />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Installed rows: reloaded 4s ago with a copy set aside, a build error, watching, folder
        missing
      </ShowcaseLabel>
      <ShowcaseDemo>
        <IsolatedQueryProvider seed={seedDevLinks}>
          <InstalledPackagesView />
        </IsolatedQueryProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>The record of dev links can’t be read</ShowcaseLabel>
      <ShowcaseDemo>
        <IsolatedQueryProvider seed={seedUnreadable}>
          <InstalledPackagesView />
        </IsolatedQueryProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>Unlink dialog</ShowcaseLabel>
      <ShowcaseDemo>
        <IsolatedQueryProvider seed={() => undefined}>
          <UnlinkDialogDemo />
        </IsolatedQueryProvider>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
