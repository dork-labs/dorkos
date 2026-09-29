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
 * `carry-plan.ts` holds {@link planCarryOver}, the pure decision table an
 * install over an existing root applies; the transaction (`../transaction.ts`)
 * performs its actions. `tree-scan.ts` walks and hashes trees without
 * following links.
 *
 * @module services/marketplace/lib/records/installed-files
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  AGENT_IDENTITY_FILES,
  INSTALL_METADATA_POSIX_PATH,
  INSTALLED_FILES_PATH,
  isReservedPackagePath,
  matchesUserEditable,
  PackageTypeSchema,
} from '@dorkos/marketplace';
import { writeFileAtomic } from '@dorkos/shared/atomic-write';
import type { Logger } from '@dorkos/shared/logger';
import { hashFile, isAtOrUnder, lstatChain, scanTree, toFsPath } from './tree-scan.js';

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

/**
 * Why a rebuilt record could not prove which files were the package's
 * (DOR-2322): the version it came from could not be fetched, it came from a
 * folder on this computer, or the fetched version did not match what was there.
 */
export const UnprovenWhySchema = z.enum(['fetch-failed', 'no-source', 'mismatch']);

/** Why a rebuilt record could not prove ownership; see {@link UnprovenWhySchema}. */
export type UnprovenWhy = z.infer<typeof UnprovenWhySchema>;

/**
 * Files kept as the person's only because nothing proved otherwise (DOR-2322),
 * and what to compare them with once something can.
 */
export const UnprovenFilesSchema = z.object({
  why: UnprovenWhySchema,
  /** The exact version the files came with: fetched by Check files to sort them. */
  from: z
    .object({
      name: z.string().min(1),
      sourceKey: z
        .object({ cloneUrl: z.string().min(1), subpath: z.string(), ref: z.string() })
        .strict(),
      commitSha: z.string().regex(/^[0-9a-f]{40}$/),
    })
    .optional(),
  /** Where each kept file sits now → the path it had in that version. */
  files: z.record(RecordPathSchema, RecordPathSchema),
});

/** Files kept because nothing proved them the package's; see {@link UnprovenFilesSchema}. */
export type UnprovenFiles = z.infer<typeof UnprovenFilesSchema>;

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
  /** Files kept as the person's because nothing proved otherwise (DOR-2322). */
  unproven: UnprovenFilesSchema.optional(),
  /**
   * `1` when every copy an update saved aside in this root is inert (DOR-2340):
   * set on a record made from a tree this version wrote, carried over by an
   * update only from a record that had it, and set by the boot migration once
   * it has fixed what an earlier version left. A record without it is one the
   * migration still has to visit. Kept in the record rather than as a file, so
   * an uninstall that removes the record leaves nothing of it behind.
   */
  savedCopies: z.literal(1).optional(),
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
    // A tree this version wrote holds no runnable or loadable saved copy.
    savedCopies: 1,
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
