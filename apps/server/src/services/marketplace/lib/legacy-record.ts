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
 * 3. **Strict first** (DOR-2322). The record is exact when the live folder
 *    matches it by the rule Check files uses (`strictDifferences`).
 * 4. **Trust check.** Otherwise some files were edited, or the commit is not
 *    what was installed: before DOR-2248 the fetcher ignored the ref on
 *    `github` and `url` sources. If more than {@link LEGACY_MISMATCH_SHARE} of
 *    the recorded paths present in the live root, and at least
 *    {@link LEGACY_MISMATCH_MIN} of them, differ in bytes, the rebuild is not
 *    the installed tree and step 5 is used instead.
 * 5. **Fallback** (no tree, a failed fetch, or a rejected rebuild): a live file
 *    is the package's only when some obtainable tree (the new version being
 *    installed, or the fetched old one) has the same bytes at the same path.
 *    The record is marked `inferred`. Everything else is kept as the person's
 *    and listed as `unproven`, with why and the commit to compare it with
 *    later: nothing is deleted on a guess, and nothing is kept silently.
 *
 * @module services/marketplace/lib/legacy-record
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PACKAGE_TEXT_MAX_BYTES, readTextFileWithin } from '@dorkos/shared/bounded-read';
import type { Logger } from '@dorkos/shared/logger';
import {
  AGENT_IDENTITY_FILES,
  isReservedPackagePath,
  MarketplacePackageManifestSchema,
  validUserEditable,
  type MarketplacePackageManifest,
  type PackageType,
} from '@dorkos/marketplace';
import { readInstallMetadataStrict, type InstallMetadata } from '../installed-metadata.js';
import type { PackageFetcher } from '../package-fetcher.js';
import { isFullCommitSha } from './git-tree.js';
import {
  computeInstalledFiles,
  hashFile,
  isNeverCarried,
  lstatChain,
  scanTree,
  writeInstalledFiles,
  type InstalledFiles,
  type UnprovenWhy,
} from './installed-files.js';
import { strictDifferences } from './integrity/strict-differences.js';
import { materializePackageSchedules } from './materialize-schedules.js';
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

/**
 * A manifest's `userEditable`, read loosely (an old tree may predate the field).
 *
 * @param tree - A package tree.
 */
export async function userEditableOf(tree: string): Promise<string[]> {
  try {
    const manifest = JSON.parse(
      await readTextFileWithin(
        fsPath(tree, '.dork/manifest.json'),
        PACKAGE_TEXT_MAX_BYTES,
        'The manifest'
      )
    ) as {
      userEditable?: unknown;
    };
    // Read off a tree that may predate the rules: an entry the schema now
    // refuses (`skills/**`, `**`) is never trusted (DOR-2197 review).
    return Array.isArray(manifest.userEditable) ? validUserEditable(manifest.userEditable) : [];
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
    const source = fetchableSourceOf(metadata);
    if (source && deps.fetcher) {
      try {
        oldTree = path.join(scratch, 'old');
        await stageInstalledCommit(source, oldTree, { fetcher: deps.fetcher, logger: deps.logger });
      } catch (err) {
        oldTree = undefined;
        deps.logger.warn('[marketplace/legacy-record] could not fetch the installed commit', {
          installRoot,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const identity = recordIdentityOf(metadata, name, type);

    if (oldTree) {
      const userEditable = await userEditableOf(oldTree);
      const rebuilt = await computeInstalledFiles(oldTree, { identity, userEditable, npmRan });
      // The strict rule first, exactly as Check files applies it; the tolerance
      // only when it misses, because the record still comes from the exact
      // commit and only some files were edited.
      const exact = (await strictDifferences(installRoot, rebuilt, userEditable)).length === 0;
      const { present, differing } = await compareWithLive(installRoot, rebuilt);
      const trusted =
        exact || !(differing >= LEGACY_MISMATCH_MIN && differing > present * LEGACY_MISMATCH_SHARE);
      if (trusted) {
        deps.logger.info('[marketplace/legacy-record] rebuilt a record from the installed commit', {
          installRoot,
          proof: exact ? 'exact' : 'tolerant',
          present,
          differing,
        });
        await writeInstalledFiles(installRoot, rebuilt);
        return rebuilt;
      }
      deps.logger.info('[marketplace/legacy-record] the installed commit does not match', {
        installRoot,
        present,
        differing,
      });
    }

    const why: UnprovenWhy = !source ? 'no-source' : oldTree ? 'mismatch' : 'fetch-failed';
    const inferred = await inferRecord(installRoot, {
      identity,
      npmRan,
      trees: [newTree, oldTree].filter((t): t is string => t !== undefined),
      why,
      ...(source && { from: source }),
    });
    await writeInstalledFiles(installRoot, inferred);
    deps.logger.info('[marketplace/legacy-record] inferred a record by matching bytes', {
      installRoot,
      why,
      files: Object.keys(inferred.files).length,
      unproven: Object.keys(inferred.unproven?.files ?? {}).length,
    });
    return inferred;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** What {@link stageInstalledCommit} fetches: an install's name and exact commit. */
export interface FetchableSource {
  name: string;
  sourceKey: NonNullable<InstallMetadata['sourceKey']>;
  commitSha: string;
}

/**
 * The name, source and full commit an install's sidecar records, or `null`
 * when there is nothing exact to fetch (no source, a local-path install, or a
 * commit that is not a full SHA).
 *
 * @param metadata - The install's sidecar, or `null`.
 */
export function fetchableSourceOf(metadata: InstallMetadata | null): FetchableSource | null {
  if (!metadata?.sourceKey || !isFullCommitSha(metadata.commitSha)) return null;
  return { name: metadata.name, sourceKey: metadata.sourceKey, commitSha: metadata.commitSha };
}

/**
 * The identity a rebuilt record carries: the sidecar's name, type and source.
 *
 * @param metadata - The install's sidecar, or `null`.
 * @param name - The name to use when the sidecar gives none.
 * @param type - The type to use when the sidecar gives none.
 */
export function recordIdentityOf(
  metadata: InstallMetadata | null,
  name: string,
  type: PackageType
): InstalledFiles['package'] {
  return {
    name: metadata?.name ?? name,
    type: metadata?.type ?? type,
    ...(metadata?.sourceKey && {
      source: {
        cloneUrl: metadata.sourceKey.cloneUrl,
        subpath: metadata.sourceKey.subpath,
        ref: metadata.sourceKey.ref,
      },
    }),
  };
}

/**
 * Fetch the exact commit an install was made from and stage it at `dest` the
 * way that install saw it: the usual copy (reserved paths stripped), then its
 * `skillRef` schedules written in (DOR-2318). The one way both record
 * rebuilds (the tolerant one here and the strict one) obtain the old tree, so
 * the two can never disagree about what was installed.
 *
 * @param source - What to fetch ({@link fetchableSourceOf}).
 * @param dest - Where to stage it; must not exist.
 * @param deps - The fetcher and a logger.
 * @throws When the fetch or the copy fails.
 */
export async function stageInstalledCommit(
  source: FetchableSource,
  dest: string,
  deps: { fetcher: Pick<PackageFetcher, 'fetchAtCommit'>; logger: Logger }
): Promise<void> {
  const fetched = await deps.fetcher.fetchAtCommit({
    packageName: source.name,
    sourceKey: source.sourceKey,
    commitSha: source.commitSha,
  });
  await stagePackageContents(fetched.path, dest, deps.logger);
  await injectInstalledSchedules(dest, deps.logger);
}

/**
 * Write the old version's `skillRef` schedules into its fetched tree, as its
 * install did into the installed copy, so the rebuilt record holds each
 * scheduled `SKILL.md` as installed rather than calling it the person's edit
 * (DOR-2318). A tree with no readable manifest, or no such schedules, is left
 * as fetched.
 */
async function injectInstalledSchedules(tree: string, logger: Logger): Promise<void> {
  let manifest: MarketplacePackageManifest;
  try {
    const parsed = MarketplacePackageManifestSchema.safeParse(
      JSON.parse(
        await readTextFileWithin(
          fsPath(tree, '.dork/manifest.json'),
          PACKAGE_TEXT_MAX_BYTES,
          'The manifest'
        )
      )
    );
    if (!parsed.success) return;
    manifest = parsed.data;
  } catch {
    return;
  }
  await materializePackageSchedules({
    manifest,
    installPath: tree,
    forms: 'skillRef',
    // Only inline schedules use a skills root, and this call places none.
    dorkHome: tree,
    logger,
  });
}

/**
 * How many recorded files are present in the live root, and how many of those
 * differ. Only a regular file reached through real directories is read: this
 * runs under the install lock, and a FIFO would block it forever and a symlink
 * could lead to `/dev/zero` or a huge file elsewhere. Anything else present at
 * a recorded path is simply not the recorded file, so it counts as differing.
 */
async function compareWithLive(
  root: string,
  record: InstalledFiles
): Promise<{ present: number; differing: number }> {
  let present = 0;
  let differing = 0;
  for (const [p, hash] of Object.entries(record.files)) {
    const { kind } = await lstatChain(root, p);
    if (kind === 'missing') continue;
    present++;
    if (kind !== 'file' || (await hashFile(fsPath(root, p))) !== hash) differing++;
  }
  return { present, differing };
}

/**
 * The fallback record: the live files whose bytes equal the same path in one
 * of `trees`. Owned paths, the installer's files, reserved paths and an agent's
 * identity files are never listed. Every other live file is `unproven`: kept
 * as the person's, named, and tied to the commit that can sort it later.
 */
async function inferRecord(
  root: string,
  opts: {
    identity: InstalledFiles['package'];
    npmRan: boolean;
    trees: string[];
    why: UnprovenWhy;
    from?: FetchableSource;
  }
): Promise<InstalledFiles> {
  const ownedPaths = opts.npmRan ? ['node_modules', 'package-lock.json'] : [];
  const identityFiles: readonly string[] =
    opts.identity.type === 'agent' ? AGENT_IDENTITY_FILES : [];
  const live = await scanTree(root, {
    skip: (p) => isNeverCarried(p, ownedPaths) || isReservedPackagePath(p),
    hash: () => true,
  });
  const files: Record<string, string> = {};
  const unproven: Record<string, string> = {};
  for (const [p, entry] of [...live.entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (entry.kind !== 'file' || !entry.hash || identityFiles.includes(p)) continue;
    for (const tree of opts.trees) {
      // The trees hold package content, so the same care as the live root:
      // only a regular file reached through real directories is read.
      if (
        (await lstatChain(tree, p)).kind === 'file' &&
        (await hashFile(fsPath(tree, p))) === entry.hash
      ) {
        files[p] = entry.hash;
        break;
      }
    }
    if (!(p in files)) unproven[p] = p;
  }
  return {
    version: 1,
    package: opts.identity,
    ownedPaths,
    files,
    pendingDefaults: {},
    userEditable: [],
    inferred: true,
    ...(Object.keys(unproven).length > 0 && {
      unproven: { why: opts.why, ...(opts.from && { from: opts.from }), files: unproven },
    }),
  };
}
