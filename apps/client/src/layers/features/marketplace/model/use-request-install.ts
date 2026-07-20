/**
 * The single entry point for "install this package" from the marketplace UI.
 *
 * @module features/marketplace/model/use-request-install
 */
import { useCallback } from 'react';
import type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';
import { useAgentCreationStore } from '@/layers/shared/model';
import { useMarketplaceStore, type InstallContext } from './marketplace-store';
import { agentPackageToCreationSeed } from './agent-package-seed';

/**
 * Route an install request by package type. A `type: 'agent'` package is an
 * agent waiting to be born: it opens the creation flow at the M1 arrival
 * confirm (name it, give it a face, then bring it to life via the standard
 * engine) instead of the formless confirm dialog — and, because creation always
 * lands the agent in its own directory, it can never overwrite an existing
 * agent's identity files. Every other package type keeps the permission-preview
 * confirm dialog.
 *
 * @returns A stable `(pkg, context?) => void` request handler.
 */
export function useRequestInstall(): (pkg: AggregatedPackage, context?: InstallContext) => void {
  const openInstallConfirm = useMarketplaceStore((s) => s.openInstallConfirm);
  const openWithSeed = useAgentCreationStore((s) => s.openWithSeed);

  return useCallback(
    (pkg: AggregatedPackage, context?: InstallContext) => {
      if (pkg.type === 'agent') {
        openWithSeed(agentPackageToCreationSeed(pkg));
        return;
      }
      openInstallConfirm(pkg, context);
    },
    [openInstallConfirm, openWithSeed]
  );
}
