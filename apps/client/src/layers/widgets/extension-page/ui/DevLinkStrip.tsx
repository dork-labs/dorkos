import { useState } from 'react';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import { Button, DevLinkPath } from '@/layers/shared/ui';
import { openLink } from '@/layers/shared/lib';
import { useDevLinks } from '@/layers/entities/marketplace';
import { UnlinkDialog, type UnlinkTarget } from '@/layers/features/marketplace';

/** Where a dev link without an installed copy is managed: the Installed list. */
const INSTALLED_LINK = '/marketplace?view=installed';

/**
 * A slim, quiet strip above an extension page whose plugin runs from a folder
 * the person linked (DOR-2696): "Dev link: <path>", and the one switch back.
 * Muted on purpose, with no alarm colour: the owner chose this.
 *
 * With an installed copy set aside, "Use installed copy" unlinks right here.
 * Without one, unlinking would remove the very page in view, so the strip
 * links to the package's Installed row instead.
 */
export function DevLinkStrip({ extension }: { extension: ExtensionRecordPublic }) {
  const { data: listing } = useDevLinks();
  const [target, setTarget] = useState<UnlinkTarget | null>(null);
  const path = extension.devLink?.path;
  if (!path) return null;
  const link = listing?.links.find(
    (entry) => entry.path === path && entry.name === extension.sourcePlugin
  );
  return (
    <div
      data-testid="extension-page-dev-link"
      className="bg-muted/40 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-4 py-1.5"
    >
      <DevLinkPath path={path} className="min-w-0 flex-1" />
      {/* No switch until the listing says whether an installed copy waits. */}
      {!listing ? null : link?.parked ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          onClick={() =>
            setTarget({
              name: link.name,
              scope: link.scope,
              ...(link.projectPath !== undefined && { projectPath: link.projectPath }),
              parked: true,
            })
          }
        >
          Use installed copy
        </Button>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          onClick={() => void openLink(INSTALLED_LINK)}
        >
          Unlink or switch
        </Button>
      )}
      <UnlinkDialog target={target} onClose={() => setTarget(null)} />
    </div>
  );
}
