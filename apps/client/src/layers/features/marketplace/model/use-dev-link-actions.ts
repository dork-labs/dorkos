import { useCallback, useState } from 'react';
import type { AggregatedPackage, InstalledPackage } from '@dorkos/shared/marketplace-schemas';
import { devLinkScopeOf } from '../lib/dev-links';
import type { UnlinkTarget } from '../ui/UnlinkDialog';
import { useRequestInstall } from './use-request-install';

/** What a surface showing dev-linked rows needs to offer their actions. */
export interface DevLinkActions {
  /** The dev link the unlink dialog is asking about, or `null`. */
  target: UnlinkTarget | null;
  /** Ask to unlink (also "Use installed copy", which is the same switch). */
  askUnlink: (installation: InstalledPackage) => void;
  /** Ask to unlink, then open the normal install dialog for the published package. */
  askInstallPublished: (installation: InstalledPackage, published: AggregatedPackage) => void;
  /** Close the dialog. */
  close: () => void;
  /** Called by the dialog once unlinking succeeded; opens the install next if asked. */
  onUnlinked: (target: UnlinkTarget) => void;
}

/**
 * The switches a dev-linked row offers (DOR-2696, design decision D3: the
 * badge only switches, it never publishes): "Use installed copy" and "Unlink"
 * open the unlink dialog; "Install published version" unlinks, then opens the
 * install dialog for the package as its marketplace lists it, scoped where
 * the link was. A cancelled install leaves the package not installed, which
 * the unlink toast says.
 */
export function useDevLinkActions(): DevLinkActions {
  const [target, setTarget] = useState<UnlinkTarget | null>(null);
  const [published, setPublished] = useState<{
    pkg: AggregatedPackage;
    installation: InstalledPackage;
  } | null>(null);
  const requestInstall = useRequestInstall();

  const toTarget = (installation: InstalledPackage): UnlinkTarget => ({
    name: installation.name,
    ...devLinkScopeOf(installation),
    parked: installation.devLink?.parked === true,
  });

  const askUnlink = useCallback((installation: InstalledPackage) => {
    setPublished(null);
    setTarget(toTarget(installation));
  }, []);

  const askInstallPublished = useCallback(
    (installation: InstalledPackage, pkg: AggregatedPackage) => {
      setPublished({ pkg, installation });
      setTarget({ ...toTarget(installation), then: 'install' });
    },
    []
  );

  const close = useCallback(() => setTarget(null), []);

  const onUnlinked = useCallback(
    (unlinked: UnlinkTarget) => {
      if (unlinked.then !== 'install' || !published) return;
      const { pkg, installation } = published;
      setPublished(null);
      requestInstall(
        pkg,
        installation.agentPath
          ? {
              agentPath: installation.agentPath,
              agentName: installation.agentName ?? installation.agentPath,
            }
          : undefined
      );
    },
    [published, requestInstall]
  );

  return { target, askUnlink, askInstallPublished, close, onUnlinked };
}
