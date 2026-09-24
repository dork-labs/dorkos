/**
 * Rebuilding the installed-files record of an install made before records
 * existed (DOR-2245, spec §9).
 *
 * The record says which files in an install root are the package's. An
 * install from before this shipped has none, so the first update, reinstall
 * or uninstall of it rebuilds one, never from the live root (which holds the
 * person's files too) but from the tree the install came from:
 *
 * 1. `install-metadata.json`'s `commitSha` and `sourceKey` name that tree, and
 *    DOR-2248's `PackageFetcher.fetchAtCommit` fetches exactly that commit
 *    (reusing its `trees/` cache when the name is the install-time name, which
 *    the sidecar's `name` is).
 * 2. The tree is staged with the same copy every install uses, and its record
 *    computed exactly as an install would.
 * 3. **Trust check.** Before DOR-2248 the fetcher ignored the ref on `github`
 *    and `url` sources, so a recorded commit may never have been the tree that
 *    was installed. If more than {@link LEGACY_MISMATCH_SHARE} of the recorded
 *    paths present in the live root, and at least
 *    {@link LEGACY_MISMATCH_MIN} of them, differ in bytes, the rebuild is not
 *    the installed tree and step 4 is used instead.
 * 4. **Fallback** (no tree, a failed fetch, or a rejected rebuild): a live file
 *    is the package's only when some obtainable tree (the new version being
 *    installed, or the fetched old one) has the same bytes at the same path.
 *    The record is marked `inferred`. Everything else is kept as the person's:
 *    nothing is deleted on a guess.
 *
 * @module services/marketplace/lib/legacy-record
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Logger } from '@dorkos/shared/logger';
import { AGENT_IDENTITY_FILES, isReservedPackagePath, type PackageType } from '@dorkos/marketplace';
import { readInstallMetadataStrict, type InstallMetadata } from '../installed-metadata.js';
import type { PackageFetcher } from '../package-fetcher.js';
import { isFullCommitSha } from './git-tree.js';
import {
  computeInstalledFiles,
  hashFile,
  isNeverCarried,
  scanTree,
  writeInstalledFiles,
  type InstalledFiles,
} from './installed-files.js';
import { stagePackageContents } from './stage-package.js';

/** Share of present recorded files that may differ before a rebuild is rejected. */
export const LEGACY_MISMATCH_SHARE = 0.1;

/** Fewest differing files that can reject a rebuild (a small package edited in two places is fine). */
export const LEGACY_MISMATCH_MIN = 3;

/** What {@link rebuildInstalledFiles} needs. */
export interface LegacyRecordDeps {
  /** Fetches the commit an install recorded; absent in contexts without the network. */
  fetcher?: Pick<PackageFetcher, 'fetchAtCommit'>;
  logger: Logger;
}

/** Join a root and a POSIX path. */
function fsPath(root: string, posixPath: string): string {
  return path.join(root, ...posixPath.split('/'));
}

/** Whether `p` exists. */
async function exists(p: string): Promise<boolean> {
  return (await stat(p).catch(() => undefined)) !== undefined;
}

/** A manifest's `userEditable`, read loosely (an old tree may predate the field). */
async function userEditableOf(tree: string): Promise<string[]> {
  try {
    const manifest = JSON.parse(await readFile(fsPath(tree, '.dork/manifest.json'), 'utf-8')) as {
      userEditable?: unknown;
    };
    return Array.isArray(manifest.userEditable)
      ? manifest.userEditable.filter((p): p is string => typeof p === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * Rebuild, write and return the record of a legacy install at `installRoot`.
 * Never throws for a missing or unreadable source: those take the fallback.
 *
 * @param installRoot - The live install root (not moved).
 * @param deps - The fetcher and a logger.
 * @param newTree - The staged new version, when an install is about to replace
 *   this one; used only by the fallback's byte-match.
 * @returns The record now written into `installRoot`.
 */
export async function rebuildInstalledFiles(
  installRoot: string,
  deps: LegacyRecordDeps,
  newTree?: string
): Promise<InstalledFiles> {
  let metadata: InstallMetadata | null = null;
  try {
    metadata = await readInstallMetadataStrict(installRoot);
  } catch (err) {
    deps.logger.warn('[marketplace/legacy-record] unreadable install sidecar; using the fallback', {
      installRoot,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const name = metadata?.name ?? path.basename(installRoot);
  const type: PackageType = metadata?.type ?? 'plugin';
  const npmRan = await exists(path.join(installRoot, 'node_modules'));
  const scratch = await mkdtemp(path.join(tmpdir(), 'dorkos-legacy-record-'));
  try {
    let oldTree: string | undefined;
    if (metadata?.sourceKey && isFullCommitSha(metadata.commitSha) && deps.fetcher) {
      try {
        const fetched = await deps.fetcher.fetchAtCommit({
          packageName: metadata.name,
          sourceKey: metadata.sourceKey,
          commitSha: metadata.commitSha,
        });
        oldTree = path.join(scratch, 'old');
        await stagePackageContents(fetched.path, oldTree, deps.logger);
      } catch (err) {
        deps.logger.warn('[marketplace/legacy-record] could not fetch the installed commit', {
          installRoot,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const identity = {
      name,
      type,
      ...(metadata?.sourceKey && {
        source: {
          cloneUrl: metadata.sourceKey.cloneUrl,
          subpath: metadata.sourceKey.subpath,
          ref: metadata.sourceKey.ref,
        },
      }),
    };

    if (oldTree) {
      const rebuilt = await computeInstalledFiles(oldTree, {
        identity,
        userEditable: await userEditableOf(oldTree),
        npmRan,
      });
      const { present, differing } = await compareWithLive(installRoot, rebuilt);
      const trusted = !(
        differing >= LEGACY_MISMATCH_MIN && differing > present * LEGACY_MISMATCH_SHARE
      );
      deps.logger.info('[marketplace/legacy-record] rebuilt a record from the installed commit', {
        installRoot,
        present,
        differing,
        trusted,
      });
      if (trusted) {
        await writeInstalledFiles(installRoot, rebuilt);
        return rebuilt;
      }
    }

    const inferred = await inferRecord(installRoot, {
      identity,
      npmRan,
      trees: [newTree, oldTree].filter((t): t is string => t !== undefined),
    });
    await writeInstalledFiles(installRoot, inferred);
    deps.logger.info('[marketplace/legacy-record] inferred a record by matching bytes', {
      installRoot,
      files: Object.keys(inferred.files).length,
    });
    return inferred;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** How many recorded files are present in the live root, and how many of those differ. */
async function compareWithLive(
  root: string,
  record: InstalledFiles
): Promise<{ present: number; differing: number }> {
  let present = 0;
  let differing = 0;
  for (const [p, hash] of Object.entries(record.files)) {
    const abs = fsPath(root, p);
    if (!(await exists(abs))) continue;
    present++;
    if ((await hashFile(abs)) !== hash) differing++;
  }
  return { present, differing };
}

/**
 * The fallback record: the live files whose bytes equal the same path in one
 * of `trees`. Owned paths, the installer's files, reserved paths and an agent's
 * identity files are never listed.
 */
async function inferRecord(
  root: string,
  opts: { identity: InstalledFiles['package']; npmRan: boolean; trees: string[] }
): Promise<InstalledFiles> {
  const ownedPaths = opts.npmRan ? ['node_modules', 'package-lock.json'] : [];
  const identityFiles: readonly string[] =
    opts.identity.type === 'agent' ? AGENT_IDENTITY_FILES : [];
  const live = await scanTree(root, {
    skip: (p) => isNeverCarried(p, ownedPaths) || isReservedPackagePath(p),
    hash: () => true,
  });
  const files: Record<string, string> = {};
  for (const [p, entry] of [...live.entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (entry.kind !== 'file' || !entry.hash || identityFiles.includes(p)) continue;
    for (const tree of opts.trees) {
      const candidate = fsPath(tree, p);
      if ((await exists(candidate)) && (await hashFile(candidate)) === entry.hash) {
        files[p] = entry.hash;
        break;
      }
    }
  }
  return {
    version: 1,
    package: opts.identity,
    ownedPaths,
    files,
    pendingDefaults: {},
    userEditable: [],
    inferred: true,
  };
}
