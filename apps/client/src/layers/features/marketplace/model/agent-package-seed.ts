/**
 * Map a marketplace agent package to a creation seed.
 *
 * @module features/marketplace/model/agent-package-seed
 */
import type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';
import type { CreationSeed } from '@/layers/shared/model';
import { packageDisplayLabel } from '@/layers/shared/lib';

/**
 * Turn a `type: 'agent'` marketplace package into an M1 arrival seed. The
 * package's `source` becomes the create API's `template` (its files are cloned
 * into the new agent's directory by the standard engine), its `description`
 * becomes the arrival job line and the agent's starting soul, and its `icon`
 * seeds the face. Identity — name, face, directory — is chosen in the flow, so
 * installing the package composes with creating the agent rather than replacing
 * an existing one's files.
 *
 * @param pkg - The aggregated agent package the user chose to install.
 * @returns A `marketplace-agent`-origin seed for `openWithSeed`.
 */
export function agentPackageToCreationSeed(pkg: AggregatedPackage): CreationSeed {
  return {
    origin: 'marketplace-agent',
    ...(pkg.marketplace ? { sourceLabel: pkg.marketplace } : {}),
    template: {
      source: pkg.source,
      displayName: packageDisplayLabel(pkg),
      ...(pkg.description ? { persona: pkg.description } : {}),
      ...(pkg.icon ? { icon: pkg.icon } : {}),
    },
  };
}
