/**
 * Stage every bundled core extension on disk where the extension discovery
 * pipeline can find it, and report each one's tier metadata.
 *
 * Generalizes the former single-extension marketplace staging helper: rather
 * than staging only Marketplace, it scans the bundled `core-extensions/` source
 * tree and version-stages each subdirectory that carries a valid
 * `extension.json`. Mirrors `services/mesh/ensure-dorkbot.ts` in spirit: runs
 * on server startup before `ExtensionManager.initialize()`, is idempotent, and
 * covers three paths per extension — fresh install, version upgrade, and no-op.
 *
 * The copied source lands in `{dorkHome}/extensions/<id>/` so that
 * `ExtensionDiscovery.scanDirectory('{dorkHome}/extensions')` picks it up
 * during discovery, exactly like a user-installed extension.
 *
 * @module services/core-extensions/ensure-core-extensions
 */
import fs from 'fs/promises';
import type { Dirent } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ExtensionManifestSchema, type ExtensionManifest } from '@dorkos/extension-api';
import type { CoreExtensionInfo } from '../extensions/extension-enable-resolution.js';
import { logger } from '../../lib/logger.js';

/** Filesystem directory of this module (works in both tsx dev and tsc dist output). */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * When running from inside a packaged Electron `app.asar` archive, redirect
 * to the real, unpacked sibling directory (`app.asar.unpacked/...`).
 *
 * Electron patches `fs` to make simple reads of `asarUnpack`'d files
 * transparent, but that redirect doesn't reliably cover a recursive
 * `fs.cp()` (this module's {@link copyDirectory}) from inside a
 * UtilityProcess — the same class of limitation `app.ts` documents for
 * `express.static`. The desktop app's `electron-builder.yml` unpacks
 * `core-extensions/**`, so the real directory always exists at this
 * substituted path when `.asar` appears at all; a no-op everywhere else
 * (tsx dev, the tsc build, the CLI bundle) since none of those run from
 * inside an asar archive.
 *
 * @param p - An absolute path, possibly pointing inside an `app.asar`.
 */
function resolveAsarUnpacked(p: string): string {
  return p.replace(`.asar${path.sep}`, `.asar.unpacked${path.sep}`);
}

/**
 * Absolute path to the canonical core-extension source tree shipped with the
 * server.
 *
 * Resolves relative to this compiled module. In development (tsx) this is
 * `apps/server/src/core-extensions/`; in the tsc build output it is
 * `apps/server/dist/core-extensions/`. Asset files such as `extension.json`
 * are copied into the dist tree by the `build` script (tsc does not copy them).
 */
const CORE_SOURCE_DIR = resolveAsarUnpacked(path.resolve(__dirname, '../../core-extensions'));

/** Read and parse a manifest file, returning `null` if it cannot be read or is invalid. */
async function readManifest(manifestPath: string): Promise<ExtensionManifest | null> {
  try {
    const raw = await fs.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const result = ExtensionManifestSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Recursively copy a directory, overwriting any existing files at the destination.
 *
 * Uses Node's native `fs.cp` with `recursive: true` and `force: true` so that an
 * upgrade path replaces stale files cleanly.
 */
async function copyDirectory(source: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  await fs.cp(source, destination, { recursive: true, force: true });
}

/**
 * Stage one bundled core extension under `{dorkHome}/extensions/<id>/`.
 *
 * Three paths: fresh install (destination absent), version upgrade (versions
 * differ or installed manifest unreadable), no-op (versions match). Returns the
 * extension's tier metadata, or `null` if the source directory carries no valid
 * `extension.json` (and is therefore not a core extension).
 *
 * @param sourceDir - Absolute path to the bundled source directory.
 * @param dorkHome - Resolved data directory path.
 */
async function stageCoreExtension(
  sourceDir: string,
  dorkHome: string
): Promise<CoreExtensionInfo | null> {
  const manifest = await readManifest(path.join(sourceDir, 'extension.json'));
  if (!manifest) return null;

  const { id, version: bundledVersion } = manifest;
  const destinationDir = path.join(dorkHome, 'extensions', id);
  const installed = await readManifest(path.join(destinationDir, 'extension.json'));
  const installedVersion = installed?.version ?? null;

  if (installedVersion === bundledVersion) {
    logger.debug('[CoreExtensions] %s already staged at version %s', id, bundledVersion);
  } else {
    if (installedVersion === null) {
      logger.info('[CoreExtensions] Installing %s %s', id, bundledVersion);
    } else {
      logger.info(
        '[CoreExtensions] Upgrading %s from %s to %s',
        id,
        installedVersion,
        bundledVersion
      );
    }
    await copyDirectory(sourceDir, destinationDir);
    logger.info('[CoreExtensions] %s staged at %s', id, destinationDir);
  }

  return {
    id,
    defaultEnabled: manifest.defaultEnabled !== false,
    canDisable: manifest.canDisable !== false,
  };
}

/**
 * Stage every bundled core extension into `{dorkHome}/extensions/<id>/` and
 * return their tier metadata.
 *
 * Scans every subdirectory of {@link CORE_SOURCE_DIR}; a subdirectory without a
 * valid `extension.json` is skipped silently (not staged, not returned). Each
 * extension is staged independently and NON-FATALLY: a copy failure for one
 * extension is logged and swallowed so it cannot abort server boot, and the
 * remaining extensions are still attempted.
 *
 * Must run before `extensionManager.initialize(cwd)` so the subsequent discovery
 * pass sees the staged directories. Callers should still wrap the call in a
 * try/catch and log failures without aborting boot (mirroring the `ensureDorkBot`
 * call site).
 *
 * @param dorkHome - Resolved data directory path (`~/.dork/` in prod, `.temp/.dork/` in dev).
 * @param sourceDir - Bundled core-extension source tree to scan. Defaults to the
 *   shipped {@link CORE_SOURCE_DIR}; overridable for testing.
 * @returns Tier metadata for each successfully-staged core extension.
 */
export async function ensureCoreExtensions(
  dorkHome: string,
  sourceDir: string = CORE_SOURCE_DIR
): Promise<CoreExtensionInfo[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(sourceDir, { withFileTypes: true });
  } catch (err) {
    logger.warn('[CoreExtensions] Could not read core-extension source dir %s', sourceDir, err);
    return [];
  }

  const staged: CoreExtensionInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const extDir = path.join(sourceDir, entry.name);
    try {
      const info = await stageCoreExtension(extDir, dorkHome);
      if (info) staged.push(info);
    } catch (err) {
      logger.warn('[CoreExtensions] Failed to stage core extension at %s — skipping', extDir, err);
    }
  }

  return staged;
}
