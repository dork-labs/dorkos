/**
 * Ensure the Dork Hub (marketplace) built-in extension is staged on disk
 * where the extension discovery pipeline can find it.
 *
 * Mirrors `services/mesh/ensure-dorkbot.ts` in spirit: runs on server startup,
 * is idempotent, and covers three paths — fresh install, version upgrade, and
 * no-op. Instead of scaffolding a brand-new workspace (as DorkBot does) it
 * copies the canonical source from
 * `apps/server/src/builtin-extensions/marketplace/` into
 * `{dorkHome}/extensions/marketplace/` so that
 * `ExtensionDiscovery.scanDirectory('{dorkHome}/extensions')` picks it up
 * during `ExtensionManager.initialize()`.
 *
 * @module services/builtin-extensions/ensure-marketplace
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { ExtensionManifestSchema } from '@dorkos/extension-api';
import { logger } from '../../lib/logger.js';

/** Filesystem directory of this module (works in both tsx dev and tsc dist output). */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Extension identifier for the Dork Hub built-in.
 *
 * Must match the `id` field in `extension.json` (kebab-case, enforced by
 * `ExtensionManifestSchema`).
 */
const EXTENSION_ID = 'marketplace';

/**
 * Absolute path to the canonical source directory shipped with the server.
 *
 * Resolves relative to this compiled module. In development (tsx) this is
 * `apps/server/src/builtin-extensions/marketplace/`. In the tsc build output
 * it is `apps/server/dist/builtin-extensions/marketplace/` — the `.ts` sources
 * are compiled alongside the rest of the server, but note that asset files
 * such as `extension.json` are not copied by `tsc` and require a separate
 * build step to be present in the dist tree.
 */
const BUILTIN_SOURCE_DIR = path.resolve(__dirname, '../../builtin-extensions/marketplace');

/** Read and parse a manifest file, returning `null` if it cannot be read. */
async function readManifestVersion(manifestPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const result = ExtensionManifestSchema.safeParse(parsed);
    if (!result.success) return null;
    return result.data.version;
  } catch {
    return null;
  }
}

/**
 * Recursively copy a directory, overwriting any existing files at the destination.
 *
 * Uses Node's native `fs.cp` with `recursive: true` and `force: true` so that
 * an upgrade path replaces stale files cleanly.
 */
async function copyDirectory(source: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  await fs.cp(source, destination, { recursive: true, force: true });
}

/**
 * Ensure the Dork Hub built-in extension is staged under `{dorkHome}/extensions/marketplace/`.
 *
 * Runs on server startup before `ExtensionManager.initialize()`. Three paths:
 * 1. **Fresh install** — destination does not exist → copy entire source tree.
 * 2. **Upgrade** — destination exists but manifest version differs from the
 *    bundled version → re-copy the source tree so stale assets are replaced.
 * 3. **Already correct** — destination exists at the current version → no-op.
 *
 * Must run before `extensionManager.initialize(cwd)` so that the subsequent
 * discovery pass sees the staged directory. The helper is non-fatal at the
 * call site: callers should wrap it in a `try/catch` and log failures
 * without aborting server boot (mirroring the `ensureDorkBot` call site).
 *
 * @param dorkHome - Resolved data directory path (`~/.dork/` in prod, `.temp/.dork/` in dev).
 */
export async function ensureBuiltinMarketplaceExtension(dorkHome: string): Promise<void> {
  const destinationDir = path.join(dorkHome, 'extensions', EXTENSION_ID);
  const sourceManifestPath = path.join(BUILTIN_SOURCE_DIR, 'extension.json');
  const destinationManifestPath = path.join(destinationDir, 'extension.json');

  const bundledVersion = await readManifestVersion(sourceManifestPath);
  if (!bundledVersion) {
    logger.warn(
      '[BuiltinExtensions] Could not read bundled Dork Hub manifest at %s — skipping ensure',
      sourceManifestPath
    );
    return;
  }

  const installedVersion = await readManifestVersion(destinationManifestPath);

  if (installedVersion === bundledVersion) {
    logger.debug('[BuiltinExtensions] Dork Hub already staged at version %s', bundledVersion);
    return;
  }

  if (installedVersion === null) {
    logger.info('[BuiltinExtensions] Installing Dork Hub %s', bundledVersion);
  } else {
    logger.info(
      '[BuiltinExtensions] Upgrading Dork Hub from %s to %s',
      installedVersion,
      bundledVersion
    );
  }

  await copyDirectory(BUILTIN_SOURCE_DIR, destinationDir);
  logger.info('[BuiltinExtensions] Dork Hub staged at %s', destinationDir);
}
