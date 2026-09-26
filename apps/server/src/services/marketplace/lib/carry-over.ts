/**
 * Carrying a person's files into a new install, and catching what they wrote
 * while it ran (DOR-2245, spec §4).
 *
 * {@link carryPersonFiles} runs after the new version is staged and BEFORE the
 * live install root is moved aside: it reads the live root, asks
 * {@link planCarryOver} what to do with every entry, and performs the plan on
 * the staged tree. The live root is only ever read. Files are cloned
 * (`COPYFILE_FICLONE`: a copy-on-write clone on APFS/btrfs/ReFS, a plain copy
 * elsewhere), their timestamps restored, symlinks recreated verbatim, special
 * files skipped. So a crash at any point leaves the person's files where they
 * were, and a failed activation restores the untouched backup.
 *
 * It also returns a {@link CarrySnapshot}: the `lstat` identity of every live
 * entry (the package's own files included, so an unchanged shipped file is
 * never mistaken for a late write) and of every clone it made, taken after
 * `utimes`. {@link lateWritePass} compares the backup against it once the new
 * version is live, and brings over anything written in between. That is the
 * common case of an agent working in its own folder while its package updates.
 *
 * @module services/marketplace/lib/carry-over
 */
import { constants as fsConstants, type Stats } from 'node:fs';
import { copyFile, lstat, mkdir, readlink, rename, rm, symlink, utimes } from 'node:fs/promises';
import path from 'node:path';
import type { PackageFileNotice } from '@dorkos/shared/marketplace-schemas';
import {
  entryStatOf,
  isNeverCarried,
  planCarryOver,
  sameEntryStat,
  scanTree,
  type CarryOverPlan,
  type EntryStat,
  type InstalledFiles,
  type StagedFacts,
} from './installed-files.js';

/** The `lstat` identities the late-write pass compares against. */
export interface CarrySnapshot {
  /** Every live entry (files and symlinks), root-relative POSIX path → stat. */
  source: Map<string, EntryStat>;
  /** Every clone made into the staged tree, root-relative POSIX path → stat after `utimes`. */
  clones: Map<string, EntryStat>;
}

/** What {@link carryPersonFiles} did. */
export interface CarryResult {
  /** The plan it performed. */
  plan: CarryOverPlan;
  /** The baseline for {@link lateWritePass}. */
  snapshot: CarrySnapshot;
}

/** Join a root and a POSIX path. */
function fsPath(root: string, posixPath: string): string {
  return path.join(root, ...posixPath.split('/'));
}

/** `lstat` or `undefined`. */
async function lstatOrUndefined(target: string): Promise<Stats | undefined> {
  try {
    return await lstat(target);
  } catch {
    return undefined;
  }
}

/**
 * Staged-tree facts backed by `lstat`, probed for every live path and its
 * ancestors. On a case-insensitive volume, asking for `readme.md` finds
 * `README.md`, which is exactly how a case-only clash is detected. Saved-copy
 * names (`*.dork-old`, `*.dork-new`) are never probed: the staged tree is the
 * new package, and staging strips those names from a package, so any such
 * name the plan picks is free there (clashes with the person's own saved
 * copies are the plan's to avoid, and it does).
 */
async function stagedFactsFor(stagingDir: string, paths: Iterable<string>): Promise<StagedFacts> {
  const kinds = new Map<string, 'file' | 'dir' | 'other' | 'missing'>();
  for (const p of paths) {
    const segments = p.split('/');
    for (let i = 1; i <= segments.length; i++) {
      const sub = segments.slice(0, i).join('/');
      if (kinds.has(sub)) continue;
      const stats = await lstatOrUndefined(fsPath(stagingDir, sub));
      kinds.set(
        sub,
        stats === undefined
          ? 'missing'
          : stats.isDirectory()
            ? 'dir'
            : stats.isFile()
              ? 'file'
              : 'other'
      );
    }
  }
  return { kindOf: (p) => kinds.get(p) ?? 'missing' };
}

/**
 * Clone one entry (file or symlink) from `src` to `dst`, replacing whatever is
 * at `dst`, and return the clone's stat after its timestamps are restored.
 * Special files are never passed here.
 */
async function cloneEntry(src: string, dst: string): Promise<EntryStat> {
  const stats = await lstat(src);
  await mkdir(path.dirname(dst), { recursive: true });
  await rm(dst, { recursive: true, force: true });
  if (stats.isSymbolicLink()) {
    await symlink(await readlink(src), dst);
  } else {
    await copyFile(src, dst, fsConstants.COPYFILE_FICLONE);
    await utimes(dst, stats.atime, stats.mtime);
  }
  return entryStatOf(await lstat(dst));
}

/**
 * Clone a whole directory tree, file by file, skipping special files; record
 * each clone's stat under its root-relative POSIX path.
 */
async function cloneTree(
  srcRoot: string,
  dstRoot: string,
  relSrc: string,
  relDst: string,
  clones: Map<string, EntryStat>,
  skipped: string[]
): Promise<void> {
  const scan = await scanTree(fsPath(srcRoot, relSrc));
  await mkdir(fsPath(dstRoot, relDst), { recursive: true });
  for (const dir of scan.dirs)
    await mkdir(fsPath(dstRoot, `${relDst}/${dir}`), { recursive: true });
  for (const [p, entry] of scan.entries) {
    if (entry.kind === 'special') {
      skipped.push(`${relSrc}/${p}`);
      continue;
    }
    clones.set(
      `${relDst}/${p}`,
      await cloneEntry(fsPath(srcRoot, `${relSrc}/${p}`), fsPath(dstRoot, `${relDst}/${p}`))
    );
  }
}

/**
 * Carry the person's files from the live install root into the staged tree
 * (spec §4 step 4). Reads the live root; writes only the staged tree.
 *
 * @param opts.liveRoot - The existing install root (not moved yet).
 * @param opts.stagingDir - The staged new version, with its record already computed.
 * @param opts.rOld - The live root's record, or `null` (then `oldHasIdentity` decides).
 * @param opts.oldHasIdentity - Whether the live root holds a package manifest.
 * @param opts.rNew - The staged record; its `files` and `pendingDefaults` are updated in place.
 * @returns The plan performed and the late-write baseline.
 */
export async function carryPersonFiles(opts: {
  liveRoot: string;
  stagingDir: string;
  rOld: InstalledFiles | null;
  oldHasIdentity: boolean;
  rNew: InstalledFiles;
}): Promise<CarryResult> {
  const { liveRoot, stagingDir, rOld, rNew } = opts;
  const ownedPaths = [...(rOld?.ownedPaths ?? []), ...rNew.ownedPaths];
  const recorded = new Set([...Object.keys(rOld?.files ?? {}), ...Object.keys(rNew.files)]);
  const live = await scanTree(liveRoot, {
    skip: (p) => isNeverCarried(p, ownedPaths),
    hash: (p) => recorded.has(p),
    stat: true,
  });
  const staged = await stagedFactsFor(stagingDir, [...live.entries.keys(), ...live.dirs]);
  const plan = planCarryOver({
    rOld,
    oldHasIdentity: opts.oldHasIdentity,
    rNew,
    live,
    staged,
    liveRoot,
  });

  const clones = new Map<string, EntryStat>();
  const skipped: string[] = [];
  for (const action of plan.actions) {
    switch (action.kind) {
      case 'carry':
        clones.set(
          action.path,
          await cloneEntry(fsPath(liveRoot, action.path), fsPath(stagingDir, action.path))
        );
        break;
      case 'carry-as':
        clones.set(
          action.savedAs,
          await cloneEntry(fsPath(liveRoot, action.path), fsPath(stagingDir, action.savedAs))
        );
        break;
      case 'carry-dir':
        await cloneTree(liveRoot, stagingDir, action.path, action.path, clones, skipped);
        break;
      case 'carry-dir-as':
        await cloneTree(liveRoot, stagingDir, action.path, action.savedAs, clones, skipped);
        break;
      case 'save-new-as': {
        const savedAs = fsPath(stagingDir, action.savedAs);
        await mkdir(path.dirname(savedAs), { recursive: true });
        await rm(savedAs, { force: true });
        await rename(fsPath(stagingDir, action.path), savedAs);
        clones.set(
          action.path,
          await cloneEntry(fsPath(liveRoot, action.path), fsPath(stagingDir, action.path))
        );
        break;
      }
      case 'drop':
        await rm(fsPath(stagingDir, action.path), { force: true });
        break;
      case 'skip-special':
        break;
    }
  }
  for (const p of skipped) plan.notices.push({ path: p, outcome: 'skipped-special' });

  // A dropped editable default stays in the record: "recorded but missing" is
  // what tells the next update the person deleted it (row 3a).
  Object.assign(rNew.files, plan.addedFiles);
  rNew.pendingDefaults = plan.pendingDefaults;

  const source = new Map<string, EntryStat>();
  for (const [p, entry] of live.entries) if (entry.stat) source.set(p, entry.stat);
  return { plan, snapshot: { source, clones } };
}

/** The first free `<p>.dork-old[.n]` in `root`, by `lstat`. */
async function freeSavedName(root: string, p: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${p}.dork-old` : `${p}.dork-old.${n}`;
    if ((await lstatOrUndefined(fsPath(root, candidate))) === undefined) return candidate;
  }
}

/** The nearest ancestor of `p` in `root` that exists as something other than a directory. */
async function blockedAncestor(root: string, p: string): Promise<string | undefined> {
  const segments = p.split('/');
  for (let i = 1; i < segments.length; i++) {
    const ancestor = segments.slice(0, i).join('/');
    const stats = await lstatOrUndefined(fsPath(root, ancestor));
    if (stats !== undefined && !stats.isDirectory()) return ancestor;
  }
  return undefined;
}

/**
 * Bring anything written into the old install while the update ran into the
 * new one (spec §4 step 6). Runs after activation and before the commit, so a
 * failure rolls the whole install back and loses nothing.
 *
 * Only an entry whose `lstat` identity differs from its step-4 snapshot, or
 * that has none, is a late write; an unchanged shipped file produces nothing.
 * A late write replaces the target's entry only when that entry is still the
 * untouched clone; otherwise it is saved beside it as `.dork-old`. An entry
 * deleted from the old install since the snapshot is removed from the new one
 * when its clone is untouched. Owned paths (`node_modules`, the npm lockfile)
 * and the installer's files are never compared.
 *
 * Residual, by design: a process whose working directory is the old install
 * keeps writing there after this pass, and those writes go with the backup.
 *
 * @param opts.backupRoot - The old install, moved aside.
 * @param opts.targetRoot - The new install, now live.
 * @param opts.snapshot - What {@link carryPersonFiles} returned.
 * @param opts.ownedPaths - Owned paths of the old and new records.
 * @returns One `late-write` notice per entry it brought over or saved.
 */
export async function lateWritePass(opts: {
  backupRoot: string;
  targetRoot: string;
  snapshot: CarrySnapshot;
  ownedPaths: readonly string[];
}): Promise<PackageFileNotice[]> {
  const { backupRoot, targetRoot, snapshot } = opts;
  const backup = await scanTree(backupRoot, {
    skip: (p) => isNeverCarried(p, opts.ownedPaths),
    stat: true,
  });
  const notices: PackageFileNotice[] = [];
  const cloneUntouched = async (p: string): Promise<boolean> => {
    const clone = snapshot.clones.get(p);
    const now = await lstatOrUndefined(fsPath(targetRoot, p));
    return clone !== undefined && now !== undefined && sameEntryStat(clone, entryStatOf(now));
  };

  for (const [p, entry] of backup.entries) {
    if (entry.kind === 'special' || entry.stat === undefined) continue;
    const before = snapshot.source.get(p);
    if (before !== undefined && sameEntryStat(before, entry.stat)) continue;
    const src = fsPath(backupRoot, p);
    const blocked = await blockedAncestor(targetRoot, p);
    const occupied = (await lstatOrUndefined(fsPath(targetRoot, p))) !== undefined;
    if (blocked === undefined && (!occupied || (await cloneUntouched(p)))) {
      await cloneEntry(src, fsPath(targetRoot, p));
      notices.push({ path: p, outcome: 'late-write' });
      continue;
    }
    // Saved aside: under a renamed copy of the blocking ancestor, or beside itself.
    const savedAs =
      blocked === undefined
        ? await freeSavedName(targetRoot, p)
        : `${await freeSavedName(targetRoot, blocked)}${p.slice(blocked.length)}`;
    await cloneEntry(src, fsPath(targetRoot, savedAs));
    notices.push({ path: p, outcome: 'late-write', savedAs });
  }

  for (const p of snapshot.source.keys()) {
    if (backup.entries.has(p)) continue;
    if (await cloneUntouched(p)) {
      await rm(fsPath(targetRoot, p), { force: true });
    }
  }
  return notices;
}
