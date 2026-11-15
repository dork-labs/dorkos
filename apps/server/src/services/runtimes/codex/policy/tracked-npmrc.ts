/**
 * Which project `.npmrc` files may stay readable on macOS: those git tracks and
 * whose bytes on disk are exactly the tracked copy (Security, DOR-4358).
 *
 * git reads only the index here (`ls-files -s`): no file content, so no
 * repository-defined filter ever runs. A `--modified` check would hash the
 * working file through the repository's own `clean` filter, a program an
 * agent can name in `.git/config`, run as the server outside the sandbox
 * (Security's Must 1 on #3751). "Unchanged" is decided here instead, at render
 * time: the path is opened without following a link, must be a regular file,
 * and its git blob hash must equal the index entry's.
 *
 * The index read runs off the turn's path and its last answer is used; until
 * the first one, no `.npmrc` is spared, so every one stays denied.
 *
 * @module services/runtimes/codex/policy/tracked-npmrc
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runSafeGit } from '@dorkos/shared/safe-git';

/** One stage-0 index entry for a regular file. */
export interface TrackedEntry {
  /** The absolute path, `/`-separated. */
  readonly file: string;
  /** The blob id the index records: 40 hex digits (SHA-1) or 64 (SHA-256). */
  readonly id: string;
}

/** The index modes of a regular file; a link (120000) or a submodule never counts. */
const REGULAR_MODES = new Set(['100644', '100755']);
/** A `.npmrc` larger than this is never spared; real ones are a few lines. */
const MAX_NPMRC_BYTES = 64 * 1024;

interface Lookup {
  entries: readonly TrackedEntry[];
  running?: Promise<void>;
}

const lookups = new Map<string, Lookup>();

/**
 * Parse `git ls-files -z -s` output (`<mode> <id> <stage>\t<path>\0` per entry)
 * into the stage-0 regular files.
 *
 * @param base - The folder git ran in; paths are relative to it.
 * @param out - git's output.
 */
export function parseIndexEntries(base: string, out: string): TrackedEntry[] {
  const entries: TrackedEntry[] = [];
  for (const record of out.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode, id, stage] = record.slice(0, tab).split(' ');
    if (
      !REGULAR_MODES.has(mode ?? '') ||
      stage !== '0' ||
      !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(id ?? '')
    )
      continue;
    entries.push({
      file: path
        .join(base, record.slice(tab + 1))
        .split(path.sep)
        .join('/'),
      id: id!,
    });
  }
  return entries;
}

/**
 * Whether the file on disk is exactly the blob the index names: opened without
 * following a link, a regular file, and hashed the way git hashes a blob.
 *
 * @param entry - One index entry.
 */
export function matchesIndex(entry: TrackedEntry): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(entry.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_NPMRC_BYTES) return false;
    const bytes = fs.readFileSync(fd);
    const algorithm = entry.id.length === 64 ? 'sha256' : 'sha1';
    const id = createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    return id === entry.id;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * The one git command this module runs. `-s` reads the index only: no working
 * file, so no repository filter can run. Exported so a test can prove that.
 *
 * @internal Exported for tests.
 */
export const INDEX_READ_ARGS = ['ls-files', '-z', '-s', '--', ':(glob)**/.npmrc'] as const;

/** Read the index's `.npmrc` entries under `base`; nothing tracked on any refusal. */
async function readIndex(base: string): Promise<TrackedEntry[]> {
  return parseIndexEntries(base, await runSafeGit(INDEX_READ_ARGS, base));
}

/**
 * The tracked `.npmrc` files under `base` whose bytes match the index right now.
 * Refreshes the index read off the turn's path and uses its last answer.
 *
 * @param base - A working folder.
 */
export function trackedUnchangedNpmrc(base: string): ReadonlySet<string> {
  const lookup = lookups.get(base) ?? { entries: [] };
  lookups.set(base, lookup);
  lookup.running ??= readIndex(base)
    .then((entries) => {
      lookup.entries = entries;
    })
    .catch(() => {
      // Not a repository, or one the runner refused: nothing is tracked.
      lookup.entries = [];
    })
    .finally(() => {
      lookup.running = undefined;
    });
  return new Set(lookup.entries.filter(matchesIndex).map((entry) => entry.file));
}

/**
 * Wait for the index reads in flight, of one base or of all.
 *
 * @param base - Only this base's; omitted, every one.
 * @internal Exported for tests.
 */
export async function settleTrackedLookups(base?: string): Promise<void> {
  await Promise.all(
    [...lookups.entries()]
      .filter(([dir]) => base === undefined || dir === base)
      .map(([, lookup]) => lookup.running)
  );
}

/**
 * Forget every index read, so each test starts cold.
 *
 * @internal Exported for tests.
 */
export function resetTrackedLookups(): void {
  lookups.clear();
}
