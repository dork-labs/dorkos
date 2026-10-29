/**
 * Verified, content-addressed snapshots of plugin folders that run by ORIGIN
 * (third security review of DOR-2527, spec `flow-multiproject` §9.1).
 *
 * ## Why
 *
 * A project copy that runs because of its trusted origin — the person approved
 * another copy from the same source, or trusts that source — was never looked
 * at by the person in THIS folder. Checking its digest at load time is not
 * enough: an extension's server half can run plugin files at runtime (flow
 * runs `<extensionDir>/../../../scripts/*.ts` with node), long after the load,
 * and an agent that can edit files in repo B could change those files between
 * the check and the run.
 *
 * So such a copy never runs from the project at all. DorkOS copies its whole
 * plugin folder into `{dorkHome}/extension-snapshots/<digest>/`, re-hashes the
 * copy, and only if it matches the digest the origin was proved against does
 * it move the copy into place, atomically. The extension then compiles and
 * runs from there: its `ctx.extensionDir` points into the snapshot, so
 * everything it reaches relative to itself (`scripts/`, `node_modules/`) is
 * the snapshot's.
 *
 * ## Rules
 *
 * - **Content-addressed.** The folder name is the digest of what it holds, so
 *   a snapshot is written once and never re-hashed: a second copy with the same
 *   files reuses it.
 * - **Read-only by convention.** Nothing in DorkOS writes into a snapshot, and
 *   an extension must not (its data, settings and secrets live elsewhere under
 *   `{dorkHome}`, keyed by its id).
 * - **Collected when unused.** After every scan, snapshots no discovered copy
 *   runs from, and no stored approval names, are removed, and so are
 *   half-written copies left by a crash. An approval's snapshot is kept so a
 *   changed copy's row can name the files that changed (DOR-3068).
 * - **What is copied** is exactly what the digest covers: every file, with
 *   `.git` and DorkOS's runtime state (install records, saved data, secrets)
 *   left out.
 *
 * Since DOR-3068 the same holds for a copy a person approved by its digest,
 * at any scope, plugin-carried or installed directly (its own folder is then
 * the root that is copied): it runs from the snapshot of exactly the files
 * the person approved, so an edit cannot land between the check and the run.
 * A copy that keeps path trust (`extension-path-trust.ts`), a dev link, and a
 * global plugin running by its origin keep running where they are.
 *
 * @module services/extensions/pin/extension-snapshots
 */
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { isRuntimeStatePath } from '../../marketplace/lib/content-hash.js';
import {
  forgetFolderDigest,
  installFolderDigest,
  isLinkInside,
} from '../../marketplace/lib/install-digest.js';
import { logger } from '../../../lib/logger.js';

/** Where snapshots live under `{dorkHome}`. */
export const SNAPSHOTS_DIR = 'extension-snapshots';

/** A half-written copy older than this is a crash's leftover. */
const STALE_TEMP_MS = 60 * 60_000;

/** The folder name a digest is stored under. */
function folderNameOf(digest: string): string | null {
  const match = /^sha256:([0-9a-f]{64})$/.exec(digest);
  return match ? (match[1] ?? null) : null;
}

/**
 * The snapshot folder for a digest.
 *
 * @param dorkHome - DorkOS's data directory.
 * @param digest - A `sha256:<hex>` install folder digest.
 */
export function snapshotRootOf(dorkHome: string, digest: string): string | null {
  const name = folderNameOf(digest);
  return name ? path.join(dorkHome, SNAPSHOTS_DIR, name) : null;
}

/**
 * Copy a tree, leaving out what the digest leaves out. A link that stays
 * inside the tree (npm's `.bin`) is copied as the same link, so it points
 * inside the copy; any other link is refused, as the digest refuses it.
 */
async function copyTree(from: string, to: string, rel = '', root = from): Promise<void> {
  await fs.mkdir(to, { recursive: true });
  for (const name of await fs.readdir(from)) {
    const childRel = rel === '' ? name : `${rel}/${name}`;
    if (childRel.toLowerCase().split('/').includes('.git') || isRuntimeStatePath(childRel)) {
      continue;
    }
    const source = path.join(from, name);
    const target = path.join(to, name);
    const stats = await fs.lstat(source);
    if (stats.isSymbolicLink()) {
      const linkText = await fs.readlink(source);
      if (!isLinkInside(root, from, linkText)) {
        throw new Error(`${childRel} is a symbolic link to outside the folder`);
      }
      await fs.symlink(linkText, target);
      continue;
    }
    if (stats.isDirectory()) await copyTree(source, target, childRel, root);
    else if (stats.isFile()) await fs.copyFile(source, target);
    else throw new Error(`${childRel} is not a file or folder`);
  }
}

/**
 * The snapshot of `installRoot` whose contents hash to `digest`, making it if
 * there is none yet.
 *
 * @param dorkHome - DorkOS's data directory.
 * @param installRoot - The folder the digest covers: a plugin's install
 *   folder, or a directly installed extension's own folder (DOR-3068).
 * @param digest - The digest the copy was approved, or its origin proved, against.
 * @returns The snapshot's root, or null when the live folder no longer holds
 *   those files (it changed since the scan) or could not be copied.
 */
export async function ensureSnapshot(
  dorkHome: string,
  installRoot: string,
  digest: string
): Promise<string | null> {
  const root = snapshotRootOf(dorkHome, digest);
  if (!root) return null;
  try {
    const stats = await fs.lstat(root);
    // A folder name is only a name: a snapshot is reused only while its files
    // still hash to the digest it is named by (DOR-3068), which catches one
    // edited after it was made and one planted before it ever was. The
    // digest's stamp cache keeps an unchanged one cheap.
    if (stats.isDirectory()) {
      const found = await installFolderDigest(root);
      if (found.kind === 'digest' && found.digest === digest) return root;
      logger.warn(
        `[Extensions] Snapshot ${root} does not hold the files it is named by; rebuilding it`
      );
    }
    await fs.rm(root, { recursive: true, force: true });
    forgetFolderDigest(root);
  } catch {
    // Not made yet.
  }
  const temp = path.join(dorkHome, SNAPSHOTS_DIR, `.tmp-${randomUUID()}`);
  try {
    await copyTree(installRoot, temp);
    const copied = await installFolderDigest(temp);
    if (copied.kind !== 'digest' || copied.digest !== digest) {
      logger.warn(
        `[Extensions] Not snapshotting ${installRoot}: its files changed while they were copied`
      );
      return null;
    }
    try {
      await fs.rename(temp, root);
    } catch (err) {
      // Another scan made the same snapshot first; used only if it holds them.
      const now = await installFolderDigest(root);
      if (now.kind === 'digest' && now.digest === digest) return root;
      throw err;
    }
    return root;
  } catch (err) {
    logger.warn(`[Extensions] Could not snapshot ${installRoot}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    forgetFolderDigest(temp);
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Remove every snapshot nothing runs from, and every half-written copy older
 * than an hour.
 *
 * @param dorkHome - DorkOS's data directory.
 * @param inUse - The snapshot roots discovered copies run from.
 * @param now - The clock, in epoch ms.
 */
export async function collectSnapshots(
  dorkHome: string,
  inUse: ReadonlySet<string>,
  now: number = Date.now()
): Promise<string[]> {
  const dir = path.join(dorkHome, SNAPSHOTS_DIR);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const target = path.join(dir, name);
    if (name.startsWith('.tmp-')) {
      const stats = await fs.lstat(target).catch(() => null);
      if (!stats || now - stats.mtimeMs < STALE_TEMP_MS) continue;
    } else if (inUse.has(path.resolve(target))) {
      continue;
    }
    await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
    removed.push(target);
  }
  return removed;
}
