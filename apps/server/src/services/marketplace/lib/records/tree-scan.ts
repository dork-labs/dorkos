/**
 * Walk and hash an install tree without ever following a link: what a record
 * is computed from, and how a live root is compared with it.
 *
 * @module services/marketplace/lib/records/tree-scan
 */
import { createHash } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

/** Join a root and a POSIX record path into a filesystem path. */
export function toFsPath(root: string, posixPath: string): string {
  return path.join(root, ...posixPath.split('/'));
}

/** Whether `posixPath` is `prefix` itself or lies beneath it. */
export function isAtOrUnder(posixPath: string, prefix: string): boolean {
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
