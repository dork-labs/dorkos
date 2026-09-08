/**
 * A minimal staging + content-hashed snapshot helper for the engine's journey
 * tests.
 *
 * A journey stages a whole repository, runs one real projection against it, and
 * then asserts the EXACT set of paths the run added, changed, or removed. The
 * exactness is the point: a sweep that deletes a file nobody planned for shows up
 * as an unexpected `removed` entry rather than as an unnoticed side effect
 * (HK-11 is exactly that bug).
 *
 * This is deliberately small. The full fixture DSL the test plan describes
 * (`plans/harness-sync-test-plan.md` §4) lands with DOR-1848; until then a
 * journey stages its own tree with plain `node:fs` calls and uses only
 * {@link snapshotTree} and {@link diffSnapshots} from here.
 *
 * @module __tests__/journeys/stage
 */
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  lstatSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/** One entry in a {@link snapshotTree} result: what the path is, and its exact content. */
export interface SnapshotEntry {
  /** What occupies the path. */
  kind: 'file' | 'dir' | 'symlink';
  /** sha256 of the file's bytes (files only). */
  sha256?: string;
  /** The literal link text (symlinks only) — never the resolved target. */
  linkText?: string;
}

/** The difference between two {@link snapshotTree} results, by repo-relative path. */
export interface SnapshotDiff {
  /** Paths present only in the later snapshot. */
  added: string[];
  /** Paths in both snapshots whose kind, content, or link text changed. */
  changed: string[];
  /** Paths present only in the earlier snapshot. */
  removed: string[];
}

/**
 * Write a file, creating its parent directories first.
 *
 * @param absPath - absolute path of the file to write.
 * @param content - the exact bytes to write.
 */
export function writeFileAt(absPath: string, content: string): void {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content);
}

/**
 * Write a JSON file with the two-space indent + trailing newline the repo's own
 * hand-authored config files use.
 *
 * @param absPath - absolute path of the file to write.
 * @param value - the value to serialize.
 */
export function writeJsonAt(absPath: string, value: unknown): void {
  writeFileAt(absPath, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Take a content-hashed snapshot of every path under `root`.
 *
 * Unlike a shape-only path listing, this hashes file bytes and records link
 * text, so an in-place rewrite of a file that already existed is visible.
 * Symlinks are never followed — a projected link is itself a change under test.
 * `.git/` internals are ignored (a staged repo may be a real git repo).
 *
 * @param root - absolute path to snapshot.
 * @returns a map of repo-relative path to what occupies it.
 */
export function snapshotTree(root: string): Map<string, SnapshotEntry> {
  const out = new Map<string, SnapshotEntry>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (rel === '.git' || rel.startsWith('.git/')) continue;
      if (entry.isSymbolicLink()) {
        out.set(rel, { kind: 'symlink', linkText: readlinkSync(abs) });
        continue;
      }
      if (entry.isDirectory()) {
        out.set(rel, { kind: 'dir' });
        walk(abs);
        continue;
      }
      out.set(rel, { kind: 'file', sha256: sha256Of(readFileSync(abs)) });
    }
  };
  walk(root);
  return out;
}

/**
 * Diff two snapshots into the exact set of paths added, changed, and removed.
 *
 * @param before - the snapshot taken before the run.
 * @param after - the snapshot taken after the run.
 * @returns sorted `added` / `changed` / `removed` path lists.
 */
export function diffSnapshots(
  before: Map<string, SnapshotEntry>,
  after: Map<string, SnapshotEntry>
): SnapshotDiff {
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];

  for (const [path, entry] of after) {
    const prior = before.get(path);
    if (!prior) added.push(path);
    else if (!sameEntry(prior, entry)) changed.push(path);
  }
  for (const path of before.keys()) if (!after.has(path)) removed.push(path);

  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
}

/** True when two snapshot entries describe identical on-disk content. */
function sameEntry(a: SnapshotEntry, b: SnapshotEntry): boolean {
  return a.kind === b.kind && a.sha256 === b.sha256 && a.linkText === b.linkText;
}

/** The lowercase hex sha256 of a buffer. */
function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * A snapshot of a tree with the root's own absolute path scrubbed out of every
 * file, as a plain object so a failing comparison prints the differing path.
 *
 * {@link snapshotTree} hashes raw bytes, which is right for before/after inside
 * ONE repo. Comparing two SEPARATELY staged repos needs this instead: a
 * projected hook command can name the plugin's install directory, which is a
 * different temp path in every staging and is never what such a test is asking
 * about. Both spellings of the root are scrubbed, because macOS hands out
 * `/var/folders/…` and resolves it to `/private/var/…`.
 *
 * @param root - absolute path to snapshot.
 * @returns repo-relative path to `dir`, `link:<text>`, or `sha:<digest>`.
 */
export function scrubbedSnapshot(root: string): Record<string, string> {
  const real = realpathSync(root);
  const out: Record<string, string> = {};
  for (const [path, entry] of snapshotTree(root)) {
    if (entry.kind === 'dir') out[path] = 'dir';
    else if (entry.kind === 'symlink') out[path] = `link:${entry.linkText}`;
    else {
      const text = readFileSync(join(root, path), 'utf8');
      out[path] =
        `sha:${sha256Of(Buffer.from(text.split(real).join('<ROOT>').split(root).join('<ROOT>')))}`;
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Read a file's exact bytes as a UTF-8 string, for a journey that asserts a
 * staged file survived byte-for-byte.
 *
 * @param absPath - absolute path of the file to read.
 * @returns the file's content.
 */
export function readText(absPath: string): string {
  return readFileSync(absPath, 'utf8');
}

/**
 * Whether something OCCUPIES a path — a dangling symlink counts, because a dead
 * link is still a thing sitting where the engine may want to write.
 *
 * This is the ownership question: "is the target free?", "did the sweep take the
 * person's link?". For "would a reader find something here?", use
 * {@link resolvesOnDisk} — the two differ on exactly the case that matters, and
 * asking the wrong one is how a `native` claim about a dead link passed P9a.
 *
 * @param absPath - the absolute path to probe.
 * @returns `true` when something occupies the path.
 */
export function existsOnDisk(absPath: string): boolean {
  try {
    lstatSync(absPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a path RESOLVES to something a reader could open — a dangling symlink
 * does not.
 *
 * The question a `native` claim has to answer: the plan says a harness reads the
 * file where it sits, and a link pointing at a file that was moved away is not a
 * file anybody reads. `existsOnDisk` answers `true` for one, which is why a
 * phantom subagent could be reported as `native` with P9a green.
 *
 * @param absPath - the absolute path to probe.
 * @returns `true` when the path resolves, following symlinks.
 */
export function resolvesOnDisk(absPath: string): boolean {
  try {
    statSync(absPath);
    return true;
  } catch {
    return false;
  }
}
