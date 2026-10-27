/**
 * Read a commit's tree through the symlinks in it (DOR-3298).
 *
 * Harness Sync links `.claude/skills/<x>` to `.agents/skills/<x>`, and git
 * stores that link as one blob at `.claude/skills/<x>`. So the path a worktree
 * reads, `.claude/skills/<x>/SKILL.md`, is not in the commit's tree at all,
 * and a lookup by it finds nothing: every linked skill with a pinned field
 * (`allowed-tools`, say) would read as new on every turn. This follows such a
 * link the way the filesystem does, inside the commit itself, and lists what
 * the link leads to under the path the worktree uses.
 *
 * Only git's own plumbing reads (`ls-tree`, `cat-file blob`), through the
 * guarded runner. A link that leads out of the repo, absolutely or by `..`, is
 * refused: its path is left out, so it reads as not on the default branch and
 * counts as a change. So is a chain longer than {@link MAX_HOPS}.
 *
 * @module services/runtimes/claude-code/repo-settings/repo-tree-links
 */
import path from 'node:path';
import { listEntries, listTree, readBlob } from './repo-git.js';

/** One entry in a commit's tree. */
type TreeEntry = { oid: string; mode: string };

/** A symlink's git mode. */
const SYMLINK_MODE = '120000';

/** The most links one path may pass through, as a loop guard. */
const MAX_HOPS = 8;

/**
 * List `paths` (repo-relative files or folders) in a commit, following any
 * symlinked folder on the way to each. What a link leads to is keyed by the
 * path asked for, never the link's target.
 *
 * @param root - The repo's working tree top.
 * @param commit - The commit to read.
 * @param paths - What to list.
 */
export async function listTreeThroughLinks(
  root: string,
  commit: string,
  paths: readonly string[]
): Promise<Map<string, TreeEntry>> {
  const out = await listTree(root, commit, paths);
  for (const rel of paths) {
    if (hasAtOrUnder(out, rel)) continue;
    for (const [key, entry] of await followLinks(root, commit, rel, 0)) out.set(key, entry);
  }
  return out;
}

/** Whether a listing holds `rel` itself or anything under it. */
function hasAtOrUnder(listed: Map<string, TreeEntry>, rel: string): boolean {
  if (listed.has(rel)) return true;
  for (const key of listed.keys()) if (key.startsWith(`${rel}/`)) return true;
  return false;
}

/**
 * What `rel` leads to when one of the folders on its way is a symlink in the
 * commit, keyed by `rel` (and what is under it); empty when none is, or the
 * link leads out of the repo.
 */
async function followLinks(
  root: string,
  commit: string,
  rel: string,
  hops: number
): Promise<Map<string, TreeEntry>> {
  const none = new Map<string, TreeEntry>();
  if (hops >= MAX_HOPS) return none;
  const parts = rel.split('/');
  const ancestors = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
  if (ancestors.length === 0) return none;
  const entries = await listEntries(root, commit, ancestors);
  const link = ancestors.find((ancestor) => entries.get(ancestor)?.mode === SYMLINK_MODE);
  if (!link) return none;
  const target = resolveInside(link, (await readBlob(root, entries.get(link)!.oid)).toString());
  if (target === undefined) return none;
  const next = `${target}${rel.slice(link.length)}`;
  const listed = await listTree(root, commit, [next]);
  const found = hasAtOrUnder(listed, next)
    ? listed
    : await followLinks(root, commit, next, hops + 1);
  const keyed = new Map<string, TreeEntry>();
  for (const [key, entry] of found) {
    if (key === next || key.startsWith(`${next}/`))
      keyed.set(`${rel}${key.slice(next.length)}`, entry);
  }
  return keyed;
}

/**
 * Where a link at `link` pointing to `text` leads, repo-relative, or
 * `undefined` when that is outside the repo (absolute, or up past its top).
 */
function resolveInside(link: string, text: string): string | undefined {
  if (text === '' || path.posix.isAbsolute(text) || /^[A-Za-z]:|^\\/.test(text)) return undefined;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(link), text));
  if (target === '.' || target === '..' || target.startsWith('../')) return undefined;
  return target.replace(/\/+$/, '');
}
