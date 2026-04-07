/**
 * Personal marketplace bootstrap — ensures `${dorkHome}/personal-marketplace/`
 * exists, is seeded with a minimal `marketplace.json` envelope, and is
 * registered with the {@link MarketplaceSourceManager} as a `file://` source so
 * the existing fetcher / resolver / search pipelines treat it like any other
 * marketplace.
 *
 * The personal marketplace is the destination for packages an agent (or the
 * user) scaffolds via the `marketplace_create_package` MCP tool. Treating it
 * as a first-class source means search, get, and install all work against
 * locally-authored packages without any special-casing in the consumers.
 *
 * @module services/marketplace-mcp/personal-marketplace
 */
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '@dorkos/shared/logger';
import type { MarketplaceSourceManager } from '../marketplace/marketplace-source-manager.js';

/** Source name used when registering the personal marketplace. */
export const PERSONAL_MARKETPLACE_NAME = 'personal' as const;

/** Dependencies required to bootstrap the personal marketplace. */
export interface PersonalMarketplaceDeps {
  /** Resolved DorkOS data directory (see `.claude/rules/dork-home.md`). */
  dorkHome: string;
  /** Source manager used to register the personal marketplace. */
  sourceManager: MarketplaceSourceManager;
  /** Logger for diagnostic output. */
  logger: Logger;
}

/**
 * Resolve the on-disk path of the personal marketplace root.
 *
 * @param dorkHome - Absolute path to the DorkOS data directory
 * @returns Absolute path to `${dorkHome}/personal-marketplace`
 */
export function personalMarketplaceRoot(dorkHome: string): string {
  return path.join(dorkHome, 'personal-marketplace');
}

/** Default README seeded on first run. Best-effort — never overwritten. */
const DEFAULT_README = `# Personal Marketplace

This directory is your personal DorkOS marketplace. Packages you scaffold via
\`marketplace_create_package\` or copy here manually become available to your
DorkOS install and to any AI agent that talks to it via MCP.

Packages live under \`packages/\` and are listed in \`marketplace.json\`.
`;

/** Default .gitignore seeded on first run. Best-effort — never overwritten. */
const DEFAULT_GITIGNORE = `# Default: ignore everything. Run \`git init\` and edit this file if you want to track contents.
*
!.gitignore
`;

/** Build the seed `marketplace.json` envelope used on first run. */
function defaultMarketplaceJson(): {
  name: typeof PERSONAL_MARKETPLACE_NAME;
  description: string;
  plugins: never[];
} {
  return {
    name: PERSONAL_MARKETPLACE_NAME,
    description: 'Your personal DorkOS marketplace — packages you scaffold or maintain locally',
    plugins: [],
  };
}

/**
 * Return `true` if `target` exists on disk, `false` otherwise. Used to gate
 * the seed writes so existing user content is never overwritten.
 */
async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the personal marketplace exists at `${dorkHome}/personal-marketplace/`
 * and is registered as a marketplace source. Idempotent — safe to call on
 * every server boot.
 *
 * On first run this creates the directory tree, seeds `marketplace.json`,
 * `README.md`, `.gitignore`, and registers a `personal` source pointing at the
 * directory via a `file://` URL. On subsequent runs the function is a no-op
 * for any seed file that already exists, and the source registration is
 * skipped when {@link MarketplaceSourceManager.get} already returns a value.
 *
 * @param deps - Bootstrap dependencies (`dorkHome`, source manager, logger)
 */
export async function ensurePersonalMarketplace(deps: PersonalMarketplaceDeps): Promise<void> {
  const root = personalMarketplaceRoot(deps.dorkHome);
  const packagesDir = path.join(root, 'packages');
  const manifestPath = path.join(root, 'marketplace.json');
  const readmePath = path.join(root, 'README.md');
  const gitignorePath = path.join(root, '.gitignore');

  await mkdir(packagesDir, { recursive: true });

  if (!(await pathExists(manifestPath))) {
    await writeFile(
      manifestPath,
      `${JSON.stringify(defaultMarketplaceJson(), null, 2)}\n`,
      'utf-8'
    );
  }

  if (!(await pathExists(readmePath))) {
    await writeFile(readmePath, DEFAULT_README, 'utf-8');
  }

  if (!(await pathExists(gitignorePath))) {
    await writeFile(gitignorePath, DEFAULT_GITIGNORE, 'utf-8');
  }

  const existing = await deps.sourceManager.get(PERSONAL_MARKETPLACE_NAME);
  if (!existing) {
    await deps.sourceManager.add({
      name: PERSONAL_MARKETPLACE_NAME,
      source: `file://${root}`,
      enabled: true,
    });
    deps.logger.info('[personal-marketplace] registered source', { root });
  }
}
