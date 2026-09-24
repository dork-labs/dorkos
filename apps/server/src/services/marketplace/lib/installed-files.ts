/**
 * The installed-files record, and the rule that decides what an install over
 * an existing root does with each file in it (DOR-2245, ADR 260923-163513).
 *
 * **The rule.** DorkOS removes or replaces only the files it can prove the
 * install put there and nobody has changed since. At install, the staged tree
 * is walked and every shipped file is written to
 * `<installRoot>/.dork/installed-files.json` with its SHA-256. Later, a file is
 * the package's only if the record lists it, it is reached through real
 * directories (no symlink anywhere on its path), and its bytes still match.
 * Everything else in an install root is the person's (or their agent's):
 * update, reinstall and a plain uninstall keep it, and only `--purge` removes it.
 *
 * Three things are never recorded, on purpose:
 *
 * - **Owned paths** (`node_modules`, and a root `package-lock.json` when the
 *   npm step ran): the installer produces them, so they are the package's
 *   wholesale, with no per-file hashes. npm rewrites the lockfile, so hashing
 *   the shipped one would mark DorkOS's own write as a person's edit.
 * - **The installer's own files and reserved paths** (`isReservedPackagePath`):
 *   they belong to the installer or the person by definition.
 * - **An agent package's identity files** (`AGENT_IDENTITY_FILES`): DorkOS's
 *   scaffold writes them after activation, and they are the agent's. A
 *   package's copy only seeds an install where the file is absent
 *   (ADR 260923-163516).
 *
 * **Reading is defensive.** A record is untrusted input (a person or agent can
 * edit it). One that fails the schema, or names a path that is absolute,
 * contains `..` or a backslash, is treated as absent. A record only ever
 * decides what may be removed, and only a file whose exact bytes it names, so
 * a tampered one cannot reach outside the root.
 *
 * {@link planCarryOver} is the pure decision table an install over an existing
 * root applies; the transaction (`../transaction.ts`) performs its actions.
 *
 * @module services/marketplace/lib/installed-files
 */
import { createHash } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  AGENT_IDENTITY_FILES,
  INSTALL_METADATA_POSIX_PATH,
  INSTALLED_FILES_PATH,
  isReservedPackagePath,
  matchesUserEditable,
  PackageTypeSchema,
  UNINSTALLED_AGENT_PATH,
} from '@dorkos/marketplace';
import { writeFileAtomic } from '@dorkos/shared/atomic-write';
import type { Logger } from '@dorkos/shared/logger';
import type { PackageFileNotice } from '@dorkos/shared/marketplace-schemas';

/** The record format this module reads and writes. */
export const INSTALLED_FILES_RECORD_VERSION = 1;

/** Installer-generated paths that are the package's wholesale, when present. */
const OWNED_PATH_CANDIDATES = ['node_modules', 'package-lock.json'] as const;

/**
 * Paths an install over an existing root never carries: the installer rewrites
 * them. (`uninstalled-agent.json` is deliberately NOT here: the agent flow
 * needs the parked identity carried into the new install.)
 */
const NEVER_CARRIED: ReadonlySet<string> = new Set([
  INSTALLED_FILES_PATH,
  INSTALL_METADATA_POSIX_PATH,
]);

/** A SHA-256 as the record spells it. */
const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** A root-relative POSIX path that stays inside the root. */
export const RecordPathSchema = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.includes('\\') &&
      !/^[A-Za-z]:/.test(p) &&
      p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..'),
    'a record path must be relative and stay inside the install root'
  );

/**
 * Where the package came from. Compared by {@link sameSource}, which ignores
 * the ref, so moving from `@main` to a release is the same package.
 */
export const RecordSourceSchema = z.union([
  z.object({ cloneUrl: z.string().min(1), subpath: z.string(), ref: z.string() }).strict(),
  z.object({ localPath: z.string().min(1) }).strict(),
]);

/** Where the package came from; see {@link RecordSourceSchema}. */
export type RecordSource = z.infer<typeof RecordSourceSchema>;

/** Who put the recorded files here. */
export const RecordIdentitySchema = z.object({
  name: z.string().min(1),
  type: PackageTypeSchema,
  source: RecordSourceSchema.optional(),
});

/** Who put the recorded files here; see {@link RecordIdentitySchema}. */
export type RecordIdentity = z.infer<typeof RecordIdentitySchema>;

/** The installed-files record (`.dork/installed-files.json`). */
export const InstalledFilesSchema = z.object({
  version: z.literal(INSTALLED_FILES_RECORD_VERSION),
  package: RecordIdentitySchema,
  /** Installer-generated paths the package owns wholesale. */
  ownedPaths: z.array(RecordPathSchema),
  /** Every recorded file, root-relative POSIX path → `sha256:<hex>`. */
  files: z.record(RecordPathSchema, HashSchema),
  /** `.dork-new` copies the installer wrote → the file each shadows. */
  pendingDefaults: z.record(RecordPathSchema, RecordPathSchema).default({}),
  /** The package's `userEditable` list at install time. */
  userEditable: z.array(z.string()).default([]),
  /** Set on the pruned record an uninstall leaves behind. */
  uninstalledAt: z.string().optional(),
  /** Set when the record was inferred by byte-matching rather than from the installed tree. */
  inferred: z.literal(true).optional(),
});

/** The installed-files record; see {@link InstalledFilesSchema}. */
export type InstalledFiles = z.infer<typeof InstalledFilesSchema>;

/** Thrown when an install root has a package identity but no usable record. */
export class LegacyInstallError extends Error {
  /**
   * Build the error for one install root.
   *
   * @param root - The install root that needs its record rebuilt first.
   */
  constructor(public readonly root: string) {
    super(`Install at ${root} has no installed-files record; rebuild it before carrying files`);
    this.name = 'LegacyInstallError';
  }
}

/**
 * Whether a path is never carried from an old install into a new one: the
 * installer's own files, and anything at or under an owned path.
 *
 * @param p - A root-relative POSIX path.
 * @param ownedPaths - The owned paths in force (old and new records together).
 */
export function isNeverCarried(p: string, ownedPaths: readonly string[]): boolean {
  return NEVER_CARRIED.has(p) || ownedPaths.some((owned) => isAtOrUnder(p, owned));
}

/** Join a root and a POSIX record path into a filesystem path. */
function toFsPath(root: string, posixPath: string): string {
  return path.join(root, ...posixPath.split('/'));
}

/** Whether `posixPath` is `prefix` itself or lies beneath it. */
function isAtOrUnder(posixPath: string, prefix: string): boolean {
  return posixPath === prefix || posixPath.startsWith(`${prefix}/`);
}

/**
 * SHA-256 of a file's bytes, streamed, as the record spells it.
 *
 * @param absPath - The file to hash.
 */
export async function hashFile(absPath: string): Promise<string> {
  return `sha256:${await fileSha256Hex(absPath)}`;
}

/**
 * The one per-file SHA-256 primitive: a file's bytes, streamed, as bare hex.
 * {@link hashFile} spells it as the record does (`sha256:<hex>`); the package
 * content hash (`content-hash.ts`, DOR-2306) folds it into a whole-tree hash.
 * Every file DorkOS hashes goes through here, so there is one definition of a
 * file's digest (DOR-2197).
 *
 * @param absPath - The file to hash.
 * @returns 64 lowercase hex characters.
 */
export async function fileSha256Hex(absPath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(absPath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** What {@link lstatChain} found at a path. */
export interface ChainFacts {
  /** What the final component is; `missing` when any component is absent. */
  kind: 'file' | 'dir' | 'symlink' | 'special' | 'missing';
  /** True when some ancestor component (below the root) is a symlink. */
  throughSymlink: boolean;
}

/** Classify an lstat result. */
function kindOf(stats: Stats): Exclude<ChainFacts['kind'], 'missing'> {
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'dir';
  return 'special';
}

/**
 * `lstat` every component of `relPath` below `root`, so nothing is ever read,
 * moved or deleted through a symlinked directory. The root itself is trusted.
 *
 * @param root - The install root.
 * @param relPath - A root-relative POSIX path.
 */
export async function lstatChain(root: string, relPath: string): Promise<ChainFacts> {
  const segments = relPath.split('/');
  let current = root;
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    let stats: Stats;
    try {
      stats = await lstat(current);
    } catch {
      return { kind: 'missing', throughSymlink: false };
    }
    const kind = kindOf(stats);
    if (i === segments.length - 1) return { kind, throughSymlink: false };
    if (kind === 'symlink') return { kind: 'symlink', throughSymlink: true };
    if (kind !== 'dir') return { kind: 'missing', throughSymlink: false };
  }
  return { kind: 'missing', throughSymlink: false };
}

/**
 * Whether the record proves `relPath` is the package's: listed, a regular
 * file reached through real directories, with matching bytes.
 *
 * @param root - The install root.
 * @param relPath - A root-relative POSIX path.
 * @param record - The root's record.
 */
export async function isProvenPackageFile(
  root: string,
  relPath: string,
  record: InstalledFiles
): Promise<boolean> {
  const expected = record.files[relPath];
  if (expected === undefined) return false;
  const facts = await lstatChain(root, relPath);
  // A path behind a symlinked directory reports the link, so it is never 'file'.
  if (facts.kind !== 'file') return false;
  return (await hashFile(toFsPath(root, relPath))) === expected;
}

/** One entry {@link scanTree} found (directories are listed separately). */
export interface TreeEntry {
  /** What it is. Symlinks are never followed; their targets are not scanned. */
  kind: 'file' | 'symlink' | 'special';
  /** `sha256:<hex>`, present only for files the caller asked to hash. */
  hash?: string;
  /** The entry's `lstat` identity, present when the caller asked for it. */
  stat?: EntryStat;
}

/**
 * The part of an `lstat` that changes when anything writes an entry: its size,
 * its mtime and its inode (an atomic rename-over replaces the inode). Compared
 * by {@link sameEntryStat}.
 */
export interface EntryStat {
  /** Bytes. */
  size: number;
  /** Modification time, milliseconds. */
  mtimeMs: number;
  /** Inode number. */
  ino: number;
}

/**
 * Reduce an `lstat` result to an {@link EntryStat}.
 *
 * @param stats - An lstat result.
 */
export function entryStatOf(stats: Stats): EntryStat {
  return { size: stats.size, mtimeMs: stats.mtimeMs, ino: stats.ino };
}

/**
 * Whether two {@link EntryStat}s describe the same, unwritten entry.
 *
 * @param a - One stat.
 * @param b - The other.
 */
export function sameEntryStat(a: EntryStat, b: EntryStat): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

/** Everything {@link scanTree} found under a root. */
export interface TreeScan {
  /** Every non-directory entry, keyed by root-relative POSIX path. */
  entries: Map<string, TreeEntry>;
  /** Every directory, root-relative POSIX path. */
  dirs: Set<string>;
}

/**
 * Walk a tree without following symlinks.
 *
 * @param root - Directory to walk.
 * @param opts - `skip(p)`: do not descend into or list `p` (checked for every
 *   entry); `hash(p)`: whether to hash the file at `p`; `stat`: record every
 *   entry's {@link EntryStat}.
 */
export async function scanTree(
  root: string,
  opts: { skip?: (p: string) => boolean; hash?: (p: string) => boolean; stat?: boolean } = {}
): Promise<TreeScan> {
  const entries = new Map<string, TreeEntry>();
  const dirs = new Set<string>();
  const walk = async (rel: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(rel === '' ? root : toFsPath(root, rel));
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const childRel = rel === '' ? name : `${rel}/${name}`;
      if (opts.skip?.(childRel)) continue;
      const stats = await lstat(toFsPath(root, childRel));
      const kind = kindOf(stats);
      if (kind === 'dir') {
        dirs.add(childRel);
        await walk(childRel);
        continue;
      }
      const entry: TreeEntry = { kind };
      if (kind === 'file' && opts.hash?.(childRel)) {
        entry.hash = await hashFile(toFsPath(root, childRel));
      }
      if (opts.stat) entry.stat = entryStatOf(stats);
      entries.set(childRel, entry);
    }
  };
  await walk('');
  return { entries, dirs };
}

/**
 * Walk a staged tree and build its record: every shipped regular file with its
 * hash, minus owned paths, installer and reserved paths, symlinks, special
 * files, and, for an agent package, its identity files.
 *
 * @param root - The staged package root.
 * @param opts - Who installed it, the manifest's `userEditable`, and whether
 *   the npm step ran (which makes `node_modules` and the lockfile owned paths).
 */
export async function computeInstalledFiles(
  root: string,
  opts: { identity: RecordIdentity; userEditable: readonly string[]; npmRan: boolean }
): Promise<InstalledFiles> {
  const ownedPaths = opts.npmRan ? [...OWNED_PATH_CANDIDATES] : [];
  const identityFiles: readonly string[] =
    opts.identity.type === 'agent' ? AGENT_IDENTITY_FILES : [];
  const excluded = (p: string): boolean =>
    ownedPaths.some((owned) => isAtOrUnder(p, owned)) ||
    NEVER_CARRIED.has(p) ||
    isReservedPackagePath(p) ||
    identityFiles.includes(p);
  const scan = await scanTree(root, { skip: excluded, hash: () => true });
  const files: Record<string, string> = {};
  for (const [p, entry] of [...scan.entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (entry.kind === 'file' && entry.hash) files[p] = entry.hash;
  }
  return {
    version: INSTALLED_FILES_RECORD_VERSION,
    package: opts.identity,
    ownedPaths,
    files,
    pendingDefaults: {},
    userEditable: [...opts.userEditable],
  };
}

/**
 * Write a record into a root, atomically.
 *
 * @param root - The install (or staged) root.
 * @param record - The record to write.
 */
export async function writeInstalledFiles(root: string, record: InstalledFiles): Promise<void> {
  await writeFileAtomic(
    toFsPath(root, INSTALLED_FILES_PATH),
    `${JSON.stringify(record, null, 2)}\n`
  );
}

/**
 * Read a root's record, or `null` when it is missing or cannot be trusted.
 *
 * @param root - The install root.
 * @param logger - Optional; told why an unusable record was ignored.
 */
export async function readInstalledFiles(
  root: string,
  logger?: Logger
): Promise<InstalledFiles | null> {
  let raw: string;
  try {
    raw = await readFile(toFsPath(root, INSTALLED_FILES_PATH), 'utf-8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger?.warn('[marketplace/installed-files] ignoring an unreadable record', { root });
    return null;
  }
  const result = InstalledFilesSchema.safeParse(parsed);
  if (!result.success) {
    logger?.warn('[marketplace/installed-files] ignoring a record that fails its schema', {
      root,
      issue: result.error.issues[0]?.message,
    });
    return null;
  }
  return result.data;
}

/**
 * Whether two recorded sources are the same package: the same clone URL and
 * subpath (the ref is ignored, so `@main` → `@v0.8.0` or a pinned commit is
 * the same package), or the same local path.
 *
 * @param a - One source.
 * @param b - The other.
 */
export function sameSource(a: RecordSource, b: RecordSource): boolean {
  if ('localPath' in a || 'localPath' in b) {
    return 'localPath' in a && 'localPath' in b && a.localPath === b.localPath;
  }
  return a.cloneUrl === b.cloneUrl && a.subpath === b.subpath;
}

/**
 * Whether a live install is whole by its own record: every recorded file is
 * present, a regular file reached through real directories, with matching
 * bytes. `unknown` when the root has no usable record.
 *
 * @param root - The install root.
 */
export async function isInstallWhole(root: string): Promise<'whole' | 'broken' | 'unknown'> {
  const record = await readInstalledFiles(root);
  if (!record) return 'unknown';
  for (const relPath of Object.keys(record.files)) {
    if (!(await isProvenPackageFile(root, relPath, record))) {
      // An edited file is still present; only a missing or non-file one breaks
      // the install, and an editable default the person deleted does not.
      const facts = await lstatChain(root, relPath);
      if (facts.kind === 'missing' && matchesUserEditable(relPath, record.userEditable)) continue;
      if (facts.kind !== 'file') return 'broken';
    }
  }
  return 'whole';
}

// ---------------------------------------------------------------------------
// The carry-over decision table
// ---------------------------------------------------------------------------

/** One step of a {@link CarryOverPlan}. Paths are root-relative POSIX. */
export type CarryAction =
  /** Copy the live entry at `path` into the staged tree at `path`, replacing what is there. */
  | { kind: 'carry'; path: string }
  /** Copy the live entry at `path` into the staged tree at `savedAs`. */
  | { kind: 'carry-as'; path: string; savedAs: string }
  /** Copy the whole live directory at `path` into the staged tree at `path`. */
  | { kind: 'carry-dir'; path: string }
  /** Copy the whole live directory at `path` into the staged tree at `savedAs`. */
  | { kind: 'carry-dir-as'; path: string; savedAs: string }
  /** Move the staged file at `path` to `savedAs`, then copy the live entry at `path` over it. */
  | { kind: 'save-new-as'; path: string; savedAs: string }
  /** Delete the staged file at `path` (the person deleted an editable default). */
  | { kind: 'drop'; path: string }
  /** A special file in the live root: never copied. */
  | { kind: 'skip-special'; path: string };

/** What {@link planCarryOver} decided. */
export interface CarryOverPlan {
  /** Steps, in the order they must run. */
  actions: CarryAction[];
  /** What to tell the person. */
  notices: PackageFileNotice[];
  /** `.dork-new` copies written: path → hash, to add to the new record's `files`. */
  addedFiles: Record<string, string>;
  /** The new record's `pendingDefaults`. */
  pendingDefaults: Record<string, string>;
}

/** What {@link planCarryOver} needs to know about the staged tree. */
export interface StagedFacts {
  /** `lstat`-backed: what occupies `posixPath` in the staged tree (case rules of the volume apply). */
  kindOf(posixPath: string): 'file' | 'dir' | 'other' | 'missing';
}

/** Inputs to {@link planCarryOver}. */
export interface CarryOverInput {
  /** The live root's record, or `null` when it has none. */
  rOld: InstalledFiles | null;
  /** Whether the live root has a package identity (a manifest or plugin.json). */
  oldHasIdentity: boolean;
  /** The staged record. */
  rNew: InstalledFiles;
  /** A {@link scanTree} of the live root, hashing every path in `rOld` or `rNew`. */
  live: TreeScan;
  /** The staged tree. */
  staged: StagedFacts;
  /** The live root's path, for error messages only. */
  liveRoot: string;
}

/** Candidate saved names for `p`: `p<suffix>`, then `p<suffix>.2`, `.3`, … */
function* savedNameCandidates(p: string, suffix: string): Generator<string> {
  yield `${p}${suffix}`;
  for (let n = 2; ; n++) yield `${p}${suffix}.${n}`;
}

/**
 * Decide what an install over an existing root does with every entry in it.
 * Pure: every filesystem fact arrives through the input. The rows are the
 * spec's §4 table (`specs/marketplace-package-file-ownership`), numbered in
 * comments below.
 *
 * @param input - See {@link CarryOverInput}.
 * @throws {LegacyInstallError} When the live root has an identity but no record.
 */
export function planCarryOver(input: CarryOverInput): CarryOverPlan {
  const { rNew, live, staged } = input;
  if (input.rOld === null && input.oldHasIdentity) throw new LegacyInstallError(input.liveRoot);
  const rOld = input.rOld;
  const oldFiles = rOld?.files ?? {};
  const newFiles = rNew.files;
  const isAgent = rNew.package.type === 'agent';
  const identityFiles: readonly string[] = isAgent ? AGENT_IDENTITY_FILES : [];
  const ownedPaths = [...(rOld?.ownedPaths ?? []), ...rNew.ownedPaths];
  const pendingOld = rOld?.pendingDefaults ?? {};
  const pendingFor = new Map(Object.entries(pendingOld).map(([dn, p]) => [p, dn]));
  const skipped = (p: string): boolean => isNeverCarried(p, ownedPaths);
  const editable = (p: string): boolean =>
    p in newFiles
      ? matchesUserEditable(p, rNew.userEditable)
      : matchesUserEditable(p, rOld?.userEditable ?? []);
  const shipped = (p: string): boolean => p in newFiles;

  // Directories carried as one unit: no recorded or newly shipped file beneath.
  const recordedPaths = [...Object.keys(oldFiles), ...Object.keys(newFiles), ...ownedPaths];
  const unitDirs: string[] = [];
  for (const dir of [...live.dirs].sort()) {
    if (unitDirs.some((u) => isAtOrUnder(dir, u))) continue;
    if (skipped(dir)) continue;
    if (recordedPaths.some((p) => p.startsWith(`${dir}/`))) continue;
    // A directory holding something that is never carried is walked file by file.
    if ([...live.entries.keys()].some((p) => isAtOrUnder(p, dir) && skipped(p))) continue;
    unitDirs.push(dir);
  }
  const inUnit = (p: string): boolean => unitDirs.some((u) => isAtOrUnder(p, u));
  const liveSymlinks = [...live.entries].filter(([, e]) => e.kind === 'symlink').map(([p]) => p);
  /** A path hidden behind a symlinked directory in the live root: never read through the link. */
  const underLiveSymlink = (p: string): boolean => liveSymlinks.some((l) => p.startsWith(`${l}/`));

  type Decision =
    | { kind: 'carry'; path: string }
    | { kind: 'carry-identity'; path: string }
    | { kind: 'carry-saved'; path: string; notice?: PackageFileNotice['outcome'] }
    | { kind: 'save-new'; path: string; pending?: string }
    | { kind: 'drop'; path: string }
    | { kind: 'skip-special'; path: string }
    | { kind: 'kept-no-longer-shipped'; path: string };
  const decisions: Decision[] = [];

  const paths = new Set<string>([
    ...Object.keys(oldFiles),
    ...live.entries.keys(),
    ...Object.keys(newFiles),
  ]);
  for (const p of [...paths].sort()) {
    if (skipped(p)) continue;
    // An unchanged pending `.dork-new` is the package's copy: refreshed or
    // dropped by its shadowed file's row. One the person edited is theirs.
    if (p in pendingOld && live.entries.get(p)?.hash === oldFiles[p]) continue;
    if (inUnit(p)) {
      if (live.entries.get(p)?.kind === 'special')
        decisions.push({ kind: 'skip-special', path: p });
      continue;
    }
    const entry = live.entries.get(p);
    if (entry?.kind === 'special') {
      decisions.push({ kind: 'skip-special', path: p });
      continue;
    }
    if (identityFiles.includes(p) || p === UNINSTALLED_AGENT_PATH) {
      // The agent's own: carried as-is; a shipped copy only seeds an absent file.
      if (entry) decisions.push({ kind: 'carry-identity', path: p });
      continue;
    }
    const recorded = p in oldFiles;
    const ships = shipped(p);
    const liveHash = entry?.kind === 'file' ? entry.hash : undefined;
    const sameAsNew = ships && liveHash !== undefined && liveHash === newFiles[p];
    const pending = pendingFor.get(p);

    if (!entry) {
      // Behind a live symlink: the link itself is carried as the person's (and
      // collides with the new version's directory); the new copy stands.
      if (underLiveSymlink(p)) continue;
      // Rows 0, 3a, 3b, 4: nothing live at this path.
      if (recorded && ships && editable(p)) decisions.push({ kind: 'drop', path: p }); // 3a
      continue; // 0, 3b: the new copy stands; 4: gone.
    }
    const edited = !recorded || entry.kind !== 'file' || liveHash !== oldFiles[p];
    if (recorded && !edited) continue; // Rows 1, 2: the package's own, unchanged.

    if (recorded) {
      // Rows 5-8: a shipped file the person changed.
      if (ships && !editable(p)) {
        if (!sameAsNew) decisions.push({ kind: 'carry-saved', path: p, notice: 'replaced-edit' }); // 5
      } else if (ships) {
        const defaultChanged = newFiles[p] !== oldFiles[p];
        if (!sameAsNew && (defaultChanged || pending)) {
          decisions.push({ kind: 'save-new', path: p, pending }); // 6, with a .dork-new
        } else if (!sameAsNew) {
          decisions.push({ kind: 'carry', path: p }); // 6, default unchanged
        }
      } else if (!editable(p)) {
        decisions.push({ kind: 'carry-saved', path: p, notice: 'replaced-edit' }); // 7
      } else {
        decisions.push({ kind: 'kept-no-longer-shipped', path: p }); // 8
      }
      continue;
    }
    // Rows 9-11: the person's own file.
    if (!ships) {
      decisions.push({ kind: 'carry', path: p }); // 9
    } else if (!editable(p)) {
      if (!sameAsNew) decisions.push({ kind: 'carry-saved', path: p, notice: 'replaced-edit' }); // 10
    } else if (!sameAsNew) {
      decisions.push({ kind: 'save-new', path: p, pending }); // 11
    }
  }

  // Destinations fixed before any saved name is chosen, so a new name never
  // lands on something another step writes.
  const fixed = new Set<string>();
  for (const d of decisions) {
    if (
      d.kind === 'carry' ||
      d.kind === 'carry-identity' ||
      d.kind === 'save-new' ||
      d.kind === 'kept-no-longer-shipped'
    )
      fixed.add(d.path);
  }
  for (const u of unitDirs) fixed.add(u);
  const allocated = new Set<string>();
  const taken = (p: string): boolean => {
    const lower = p.toLowerCase();
    return (
      staged.kindOf(p) !== 'missing' ||
      [...fixed, ...allocated].some((q) => q === p || q.toLowerCase() === lower)
    );
  };
  const allocate = (p: string, suffix: '.dork-old' | '.dork-new'): string => {
    for (const candidate of savedNameCandidates(p, suffix)) {
      if (!taken(candidate)) {
        allocated.add(candidate);
        return candidate;
      }
    }
    /* c8 ignore next */
    throw new Error('unreachable');
  };
  /** The nearest ancestor of `p` the staged tree holds as something other than a directory. */
  const blockingAncestor = (p: string): string | undefined => {
    const segments = p.split('/');
    for (let i = 1; i < segments.length; i++) {
      const ancestor = segments.slice(0, i).join('/');
      const k = staged.kindOf(ancestor);
      if (k !== 'missing' && k !== 'dir') return ancestor;
    }
    return undefined;
  };
  const renamedAncestors = new Map<string, string>();
  /**
   * Where to save `p` aside: `p<suffix>` (first free name), or, when an
   * ancestor is a file in the new version, the same relative path inside that
   * ancestor's free `.dork-old` directory, shared by everything beneath it.
   */
  const saveTarget = (p: string, suffix: '.dork-old' | '.dork-new'): string => {
    const ancestor = blockingAncestor(p);
    if (ancestor === undefined) return allocate(p, suffix);
    let renamed = renamedAncestors.get(ancestor);
    if (renamed === undefined) {
      renamed = allocate(ancestor, '.dork-old');
      renamedAncestors.set(ancestor, renamed);
    }
    return `${renamed}${p.slice(ancestor.length)}`;
  };
  /** A write to `p` collides when the staged tree has something there the new version does not ship at exactly `p`. */
  const collides = (p: string, want: 'file' | 'dir'): boolean => {
    if (blockingAncestor(p) !== undefined) return true;
    const k = staged.kindOf(p);
    if (k === 'missing') return false;
    if (want === 'file' && k === 'file' && p in newFiles) return false;
    return true;
  };

  const plan: CarryOverPlan = { actions: [], notices: [], addedFiles: {}, pendingDefaults: {} };
  for (const u of unitDirs) {
    if (collides(u, 'dir')) {
      fixed.delete(u);
      const savedAs = saveTarget(u, '.dork-old');
      plan.actions.push({ kind: 'carry-dir-as', path: u, savedAs });
      plan.notices.push({ path: u, outcome: 'replaced-edit', savedAs });
    } else {
      plan.actions.push({ kind: 'carry-dir', path: u });
    }
  }
  for (const d of decisions) {
    switch (d.kind) {
      case 'skip-special':
        plan.actions.push({ kind: 'skip-special', path: d.path });
        plan.notices.push({ path: d.path, outcome: 'skipped-special' });
        break;
      case 'drop':
        plan.actions.push({ kind: 'drop', path: d.path });
        break;
      case 'carry-identity': {
        // Identity files are never recorded, so a shipped seed is not in
        // `newFiles`; it is still only a seed, and the agent's own file
        // replaces it. Only a directory (or a file ancestor) there is a clash.
        const k = staged.kindOf(d.path);
        if (blockingAncestor(d.path) === undefined && (k === 'missing' || k === 'file')) {
          plan.actions.push({ kind: 'carry', path: d.path });
          break;
        }
        fixed.delete(d.path);
        const savedAs = saveTarget(d.path, '.dork-old');
        plan.actions.push({ kind: 'carry-as', path: d.path, savedAs });
        plan.notices.push({ path: d.path, outcome: 'replaced-edit', savedAs });
        break;
      }
      case 'carry':
      case 'kept-no-longer-shipped': {
        if (!(d.path in newFiles) && collides(d.path, 'file')) {
          // Something the new version put here under another spelling or kind.
          fixed.delete(d.path);
          const savedAs = saveTarget(d.path, '.dork-old');
          plan.actions.push({ kind: 'carry-as', path: d.path, savedAs });
          plan.notices.push({ path: d.path, outcome: 'replaced-edit', savedAs });
          break;
        }
        plan.actions.push({ kind: 'carry', path: d.path });
        if (d.kind === 'kept-no-longer-shipped') {
          plan.notices.push({ path: d.path, outcome: 'kept-no-longer-shipped' });
        }
        break;
      }
      case 'carry-saved': {
        const savedAs = saveTarget(d.path, '.dork-old');
        plan.actions.push({ kind: 'carry-as', path: d.path, savedAs });
        plan.notices.push({ path: d.path, outcome: d.notice ?? 'replaced-edit', savedAs });
        break;
      }
      case 'save-new': {
        // Reuse the pending `.dork-new` name: it is the package's copy to refresh.
        const savedAs = d.pending ?? allocate(d.path, '.dork-new');
        if (d.pending) allocated.add(d.pending);
        plan.actions.push({ kind: 'save-new-as', path: d.path, savedAs });
        plan.notices.push({ path: d.path, outcome: 'kept-edit', savedAs });
        plan.addedFiles[savedAs] = newFiles[d.path];
        plan.pendingDefaults[savedAs] = d.path;
        break;
      }
    }
  }
  return plan;
}
