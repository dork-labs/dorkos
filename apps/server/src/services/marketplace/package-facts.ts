/**
 * The package reads of the agent facts port (spec `computer-side-starts-alone`
 * §5.3), over the marketplace files that keep them: the sources DorkOS knows,
 * each source's cached catalog, the project install index and an install
 * folder's digest. Startup, harness boot and the CLI's harness verbs hand
 * them to the harness code (`services/harness/agent-facts.ts`).
 *
 * @module services/marketplace/package-facts
 */
import type { PackageFactsPort } from '@dorkos/shared/agent-facts';
import { MarketplaceCache } from './cache/marketplace-cache.js';
import { installFolderDigest } from './lib/install-digest.js';
import { readProjectInstalls } from './lib/project-install-index.js';
import { MarketplaceSourceManager } from './sources/marketplace-source-manager.js';

/** The package reads, over a DorkOS data directory's own marketplace files. */
export const packageFacts: PackageFactsPort = {
  packageSources: async (dorkHome) =>
    (await new MarketplaceSourceManager(dorkHome).list()).map(({ name, source }) => ({
      name,
      source,
    })),
  cachedPackageNames: async (dorkHome, sourceName) => {
    const cached = await new MarketplaceCache(dorkHome).readMarketplace(sourceName);
    return cached ? cached.json.plugins.map((plugin) => plugin.name) : null;
  },
  projectInstalls: (dorkHome) => readProjectInstalls(dorkHome),
  installDigest: (installRoot) => installFolderDigest(installRoot),
};
