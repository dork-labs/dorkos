/**
 * A deterministic content hash of a package tree, and a cheap way to tell
 * whether it could have changed (DOR-2306).
 *
 * A person's approval of a global package is an approval of its BYTES, not
 * only of the list of commands it declares: `hooks.json` naming
 * `${CLAUDE_PLUGIN_ROOT}/hooks/fmt.sh` says nothing about what `fmt.sh` does.
 * So the approval binds {@link hashTree}'s digest of the installed tree, and
 * activation checks it again before a package loads.
 *
 * ## What the hash covers
 *
 * Every regular file (path, whether it is executable, and a SHA-256 of its
 * bytes) and every symbolic link (path and target), sorted by path. Directories
 * are implied by the paths in them. Nothing is followed out of the tree: a link
 * whose target leaves the root, and anything that is neither a file, a link
 * nor a directory, makes the tree unhashable ({@link TreeUnhashableError}),
 * because the bytes it would run cannot be pinned.
 *
 * ## What it skips
 *
 * Only what the caller's `skip` says. {@link isRuntimeStatePath} names the
 * paths DorkOS itself writes into an install root after the package lands
 * (settings, secrets, install records): they change without the package
 * changing, and none of them is code the package runs. DOR-2245's
 * person-editable paths (`userEditable`, never effect-bearing by that design)
 * belong in the same skip once it lands; DOR-2197's pinned-tree check can
 * reuse this module with its own skip.
 *
 * ## The fingerprint
 *
 * {@link walkTree} records each entry's size, mtime, ctime, inode and mode.
 * ctime cannot be set by a process (only the kernel moves it, on any write,
 * chmod, rename or utimes), so an unchanged fingerprint means no byte was
 * rewritten since it was taken. {@link TreeHashCache} re-hashes a tree only
 * when that changes, which is what lets activation re-check every global
 * package at the start of each turn for the cost of an `lstat` walk.
 *
 * @module services/marketplace/lib/content-hash
 */
import { createHash } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * Paths inside an install root that DorkOS writes after the package lands:
 * the package's saved data and secrets, and the install records. Root-relative
 * POSIX paths; a directory covers everything under it.
 */
export const RUNTIME_STATE_PATHS: readonly string[] = [
  '.dork/data',
  '.dork/secrets.json',
  '.dork/install-metadata.json',
  '.dork/installed-files.json',
  '.dork/uninstalled-agent.json',
];

/**
 * Whether a root-relative POSIX path is DorkOS's runtime state rather than
 * package content ({@link RUNTIME_STATE_PATHS}).
 *
 * @param posixPath - A root-relative POSIX path.
 */
export function isRuntimeStatePath(posixPath: string): boolean {
  return RUNTIME_STATE_PATHS.some(
    (prefix) => posixPath === prefix || posixPath.startsWith(`${prefix}/`)
  );
}

/** Thrown when a tree holds something whose bytes cannot be pinned. */
export class TreeUnhashableError extends Error {
  /**
   * Build the error.
   *
   * @param entry - The root-relative path that could not be hashed.
   * @param why - Plain words for why.
   */
  constructor(
    public readonly entry: string,
    why: string
  ) {
    super(`${entry} ${why}`);
    this.name = 'TreeUnhashableError';
  }
}

/** One non-directory entry of a walked tree. */
export interface TreeEntry {
  /** Root-relative POSIX path. */
  path: string;
  /** A regular file, or a symbolic link (never followed). */
  kind: 'file' | 'link';
  /** Whether any execute bit is set (files only). */
  executable: boolean;
  /** The link's target, verbatim (links only). */
  target?: string;
  /** The `lstat` facts the fingerprint is made of. */
  stat: { size: number; mtimeMs: number; ctimeMs: number; ino: number; mode: number };
}

/** Options for {@link walkTree} and {@link hashTree}. */
export interface TreeWalkOptions {
  /** Leave this root-relative POSIX path (and anything under it) out. */
  skip?: (posixPath: string) => boolean;
  /** Leave every symbolic link out instead of recording it. */
  skipLinks?: boolean;
}

/** A walked tree: its entries in path order, and the fingerprint of their stats. */
export interface TreeWalk {
  /** The directory walked (its real path when the root is itself a link). */
  root: string;
  /** Every recorded entry, sorted by path. */
  entries: TreeEntry[];
  /** A digest of every entry's path, kind, target and stat facts. */
  fingerprint: string;
}

/**
 * Walk a tree without following links, recording each file and link with the
 * stat facts that change whenever it is written.
 *
 * @param root - The tree to walk. A root that is itself a link is resolved
 *   once (a linked install), and its real directory walked.
 * @param opts - What to skip.
 * @returns The entries and their fingerprint.
 * @throws {TreeUnhashableError} For a link that points out of the tree, or an
 *   entry that is neither a file, a link nor a directory.
 */
export async function walkTree(root: string, opts: TreeWalkOptions = {}): Promise<TreeWalk> {
  const realRoot = await realpath(root);
  const entries: TreeEntry[] = [];
  const visit = async (rel: string): Promise<void> => {
    const dir = rel === '' ? realRoot : path.join(realRoot, ...rel.split('/'));
    const names = (await readdir(dir)).sort();
    for (const name of names) {
      const childRel = rel === '' ? name : `${rel}/${name}`;
      if (opts.skip?.(childRel)) continue;
      const abs = path.join(dir, name);
      const stats = await lstat(abs);
      if (stats.isDirectory()) {
        await visit(childRel);
        continue;
      }
      if (stats.isSymbolicLink()) {
        if (opts.skipLinks) continue;
        const target = await readlink(abs);
        const resolved = path.resolve(path.dirname(abs), target);
        if (resolved !== realRoot && !resolved.startsWith(`${realRoot}${path.sep}`)) {
          throw new TreeUnhashableError(childRel, 'is a link that points outside the package');
        }
        entries.push({
          path: childRel,
          kind: 'link',
          executable: false,
          target,
          stat: statOf(stats),
        });
        continue;
      }
      if (!stats.isFile()) {
        throw new TreeUnhashableError(childRel, 'is not a regular file');
      }
      entries.push({
        path: childRel,
        kind: 'file',
        executable: (stats.mode & 0o111) !== 0,
        stat: statOf(stats),
      });
    }
  };
  await visit('');
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify(
        entries.map((e) => [
          e.path,
          e.kind,
          e.target ?? null,
          e.stat.size,
          e.stat.mtimeMs,
          e.stat.ctimeMs,
          e.stat.ino,
          e.stat.mode,
        ])
      ),
      'utf8'
    )
    .digest('hex');
  return { root: realRoot, entries, fingerprint };
}

/** The `lstat` facts a fingerprint is made of. */
function statOf(stats: Stats): TreeEntry['stat'] {
  return {
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    ino: stats.ino,
    mode: stats.mode,
  };
}

/** SHA-256 of a file's bytes, streamed. */
async function hashFileBytes(absPath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(absPath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * The content digest of a walked tree: each file's path, executable bit and
 * byte hash, and each link's path and target, in path order.
 *
 * @param walk - A tree from {@link walkTree}.
 * @returns `sha256:<hex>`.
 */
export async function digestWalk(walk: TreeWalk): Promise<string> {
  const outer = createHash('sha256');
  for (const entry of walk.entries) {
    if (entry.kind === 'link') {
      outer.update(`L\0${entry.path}\0${entry.target ?? ''}\n`, 'utf8');
      continue;
    }
    const bytes = await hashFileBytes(path.join(walk.root, ...entry.path.split('/')));
    outer.update(`F\0${entry.path}\0${entry.executable ? 'x' : '-'}\0${bytes}\n`, 'utf8');
  }
  return `sha256:${outer.digest('hex')}`;
}

/**
 * Walk and hash a tree in one call.
 *
 * @param root - The tree.
 * @param opts - What to skip.
 * @returns `sha256:<hex>`.
 * @throws {TreeUnhashableError} See {@link walkTree}.
 */
export async function hashTree(root: string, opts: TreeWalkOptions = {}): Promise<string> {
  return digestWalk(await walkTree(root, opts));
}

/**
 * Hashes of trees, re-computed only when a tree's fingerprint changes. One
 * instance per server; entries are keyed by root and the caller's skip, so
 * two different skips never share an answer.
 */
export class TreeHashCache {
  private readonly cache = new Map<string, { fingerprint: string; hash: string }>();

  /**
   * The content hash of a tree, from the cache when nothing in it was written
   * since it was last hashed.
   *
   * @param root - The tree.
   * @param key - Names the skip in force, so different skips cache apart.
   * @param opts - What to skip.
   * @returns `sha256:<hex>`.
   * @throws {TreeUnhashableError} See {@link walkTree}.
   */
  async hash(root: string, key: string, opts: TreeWalkOptions = {}): Promise<string> {
    const walk = await walkTree(root, opts);
    const cacheKey = `${key}\0${walk.root}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.fingerprint === walk.fingerprint) return cached.hash;
    const hash = await digestWalk(walk);
    // Written after the digest: if the tree changed while it was being read,
    // the next call's fingerprint differs and it is hashed again.
    this.cache.set(cacheKey, { fingerprint: walk.fingerprint, hash });
    return hash;
  }

  /** Forget every cached hash. */
  clear(): void {
    this.cache.clear();
  }
}

/** Root-level files a staged package has that an installed copy does not, or has differently. */
const INSTALL_WRITTEN_AT_ROOT: ReadonlySet<string> = new Set([
  'node_modules',
  'package-lock.json',
  '.npmrc',
]);

/**
 * The part of a package tree that is the package as it was fetched, the same
 * whether it is read from the cache (a preview) or from its install root:
 * every file but DorkOS's runtime state, the npm step's `node_modules` and
 * lockfile, the root `.npmrc` the install strips, and links (the install
 * strips those too).
 *
 * This is what a person's approval of an install or update is compared on:
 * the preview hashes the staged package, and the install is recorded as
 * approved only when its installed copy hashes the same.
 *
 * @param root - A staged or installed package root.
 * @returns `sha256:<hex>`.
 * @throws {TreeUnhashableError} See {@link walkTree}.
 */
export function shippedContentHash(root: string): Promise<string> {
  return hashTree(root, {
    skip: (p) =>
      isRuntimeStatePath(p) ||
      INSTALL_WRITTEN_AT_ROOT.has(p) ||
      p === '.git' ||
      p.startsWith('.git/'),
    skipLinks: true,
  });
}
