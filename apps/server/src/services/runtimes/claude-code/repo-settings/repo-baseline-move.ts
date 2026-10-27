/**
 * What a repo's hooks would run at a default-branch commit (DOR-3298): whether
 * it changed since the pinned commit, and what a trust card shows a person.
 *
 * An agent with a shell can commit on top of the pinned commit and move the
 * branch to it (`git update-ref`), or make a repo of its own. Taking every
 * forward move would let that commit's hooks run unreviewed; asking on every
 * move would ask on each merge. So a move is compared first, and taken without
 * asking only when nothing below changed. A repo DorkOS can't trust as it
 * stands gets one trust card built from the commit a yes records, never from
 * the worktree the turn happens to stand in.
 *
 * What counts, at either commit:
 *
 * - any file under a `.claude/hooks/` folder, and the file each symlink there
 *   points at;
 * - a `.claude/settings.json`, by the parts that run code or widen what runs;
 * - a `.mcp.json`, as parsed JSON;
 * - subagent and skill files, by their `hooks` and `mcpServers` frontmatter;
 * - the repo files any of those commands name.
 *
 * Anything else under `.claude/` (commands, skill text) does not count at the
 * two commits. A commit in between that touched anything under a `.claude/`
 * or an `.agents/` does, so a move past one asks (DOR-3298 M2).
 *
 * @module services/runtimes/claude-code/repo-settings/repo-baseline-move
 */
import path from 'node:path';
import { canonicalJson, collectCommands } from '../folder-settings/folder-config-pin.js';
import { namedTargets, pickAgentFileFields } from '../folder-settings/folder-config-scripts.js';
import { isWithin, repoRelative, sha256 } from './repo-files.js';
import { changedPaths, listTree, listTreeMatching, readBlob, touchedBetween } from './repo-git.js';
import { pickPowerSettings } from './repo-local-settings.js';
import { fileDiff } from './text-diff.js';

/** Where every file the check reads lives, as git glob pathspecs. */
const HOOK_PATHSPECS = ['**/.claude/**', '**/.mcp.json'];

/**
 * What a commit in between may not touch: the above, and `.agents/`, where
 * Harness Sync keeps the skills `.claude/skills/<x>` links to. The baseline
 * reads those links through (`repo-tree-links.ts`), so a skill's frontmatter
 * changed there and reverted after would otherwise slip past M2.
 */
const BETWEEN_PATHSPECS = [...HOOK_PATHSPECS, '**/.agents/**'];

/** A symlink's git mode. */
const SYMLINK_MODE = '120000';

/** How a path is compared. */
type PathKind = 'script' | 'settings' | 'mcp' | 'frontmatter';

/** One path that counts, and how it is compared. */
interface CountedPath {
  rel: string;
  kind: PathKind;
}

/** How a repo-relative path is compared, or `null` when it runs nothing. */
function kindOf(rel: string): PathKind | null {
  const parts = rel.split('/');
  if (parts.at(-1) === '.mcp.json') return 'mcp';
  const at = parts.lastIndexOf('.claude');
  if (at < 0) return null;
  const rest = parts.slice(at + 1);
  if (rest[0] === 'hooks') return 'script';
  if (rest.length === 1 && rest[0] === 'settings.json') return 'settings';
  if (rest[0] === 'agents' && rel.endsWith('.md')) return 'frontmatter';
  if (rest[0] === 'skills' && rest.length === 3 && rest[2] === 'SKILL.md') return 'frontmatter';
  return null;
}

/** A file's text at a commit, or `null` when the commit has none. */
async function textAt(root: string, commit: string, rel: string): Promise<string | null> {
  const entry = (await listTree(root, commit, [rel])).get(rel);
  return entry ? (await readBlob(root, entry.oid)).toString('utf8') : null;
}

/**
 * The part of a file that runs, as the card shows it and the comparison reads
 * it; `null` when the commit has no such file or it runs nothing.
 */
function runningPart(kind: PathKind, text: string | null): string | null {
  if (text === null) return null;
  if (kind === 'script') return text;
  if (kind === 'frontmatter') {
    const fields = pickAgentFileFields(text);
    return Object.keys(fields).length > 0 ? JSON.stringify(fields, null, 2) : null;
  }
  try {
    const value = JSON.parse(text) as unknown;
    const picked = kind === 'settings' ? pickPowerSettings(value) : value;
    return picked === null ? null : JSON.stringify(picked, null, 2);
  } catch {
    return `(does not parse: ${sha256(text)})`;
  }
}

/**
 * The repo files a commit's hooks reach beyond the folders above: what its
 * settings and frontmatter commands name, and what each hook symlink points
 * at. Repo-relative, inside the repo only.
 */
async function reachedScripts(
  root: string,
  commit: string,
  listed: Map<string, { oid: string; mode: string }>,
  dorkHome: string
): Promise<string[]> {
  const reached = new Set<string>();
  const plugins = path.resolve(dorkHome, 'plugins');
  for (const [rel, entry] of listed) {
    const kind = kindOf(rel);
    if (kind === 'script' && entry.mode === SYMLINK_MODE) {
      const link = (await readBlob(root, entry.oid)).toString('utf8');
      const target = path.resolve(root, path.dirname(rel), link);
      if (isWithin(root, target) && target !== root) reached.add(repoRelative(root, target));
      continue;
    }
    if (kind !== 'settings' && kind !== 'frontmatter') continue;
    const text = (await readBlob(root, entry.oid)).toString('utf8');
    try {
      const picked =
        kind === 'settings'
          ? pickPowerSettings(JSON.parse(text) as unknown)
          : pickAgentFileFields(text);
      if (!picked) continue;
      // A command resolves from the folder its `.claude` sits in, as the launch
      // resolves it from the turn's folder (DOR-3298 M4): never the repo top.
      const commands: string[] = [];
      collectCommands(picked, commands);
      const owner = path.join(
        root,
        ...rel.split('/').slice(0, rel.split('/').lastIndexOf('.claude'))
      );
      for (const target of namedTargets(owner, plugins, commands)) {
        if (isWithin(root, target) && target !== root) reached.add(repoRelative(root, target));
      }
    } catch {
      // A settings file that doesn't parse is compared as a file of its own.
    }
  }
  return [...reached];
}

/**
 * The paths that count at `to`, or, with `from`, the ones that differ between
 * the two commits. Sorted, each once.
 */
async function countedPaths(
  root: string,
  from: string | null,
  to: string,
  dorkHome: string
): Promise<CountedPath[]> {
  const commits = from === null ? [to] : [from, to];
  const listings = await Promise.all(
    commits.map((commit) => listTreeMatching(root, commit, HOOK_PATHSPECS))
  );
  const counted = new Map<string, PathKind>();
  const candidates =
    from === null
      ? [...listings[0].keys()]
      : await changedPaths(root, from, to, HOOK_PATHSPECS, 'glob');
  for (const rel of candidates) {
    const kind = kindOf(rel);
    if (kind) counted.set(rel, kind);
  }
  const reached = new Set<string>();
  for (const [index, commit] of commits.entries()) {
    for (const rel of await reachedScripts(root, commit, listings[index], dorkHome)) {
      reached.add(rel);
    }
  }
  const scripts = [...reached].filter((rel) => !counted.has(rel));
  const changedScripts =
    from === null || scripts.length === 0
      ? scripts
      : await changedPaths(root, from, to, scripts, 'literal');
  for (const rel of changedScripts) counted.set(rel, 'script');
  return [...counted]
    .map(([rel, kind]) => ({ rel, kind }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** What runs at each side of one counted path. */
async function sides(
  root: string,
  from: string | null,
  to: string,
  { rel, kind }: CountedPath
): Promise<{ before: string | null; after: string | null }> {
  const [before, after] = await Promise.all([
    from === null ? null : textAt(root, from, rel),
    textAt(root, to, rel),
  ]);
  return { before: runningPart(kind, before), after: runningPart(kind, after) };
}

/**
 * Whether the hooks, MCP servers or allow rules a repo would run differ
 * between `from` and `to`. Throws when git fails, which the caller treats as a
 * change.
 *
 * @param root - The repo's working tree top.
 * @param from - The commit DorkOS pinned.
 * @param to - The commit the default branch points at now.
 * @param dorkHome - DorkOS's data folder, whose `plugins/` scripts are not the repo's.
 */
export async function hooksChangedBetween(
  root: string,
  from: string,
  to: string,
  dorkHome: string
): Promise<boolean> {
  const counted = await countedPaths(root, from, to, dorkHome);
  for (const entry of counted) {
    if (entry.kind === 'script') return true;
    const { before, after } = await sides(root, from, to, entry);
    if (before !== after) return true;
  }
  // The endpoints agree, but a commit in between may have run something: an
  // agent commits a hook on top of the pinned commit, then "reverts" it on the
  // way to the tip, and checks the middle out (DOR-3298 M2). Any commit in the
  // range that touched anything under a `.claude/`, an `.mcp.json` or a script
  // those name counts as a change: wider than the endpoints, because a commit
  // in between becomes a trusted fork point, and a subagent, skill or command
  // added there and reverted after carries hooks and tools of its own.
  const scripts = [
    ...new Set([
      ...(await reachedAt(root, from, dorkHome)),
      ...(await reachedAt(root, to, dorkHome)),
    ]),
  ];
  return touchedBetween(root, from, to, [
    ...BETWEEN_PATHSPECS.map((spec) => `:(glob)${spec}`),
    ...scripts.map((rel) => `:(literal)${rel}`),
  ]);
}

/** The scripts a commit's hooks reach, repo-relative. */
async function reachedAt(root: string, commit: string, dorkHome: string): Promise<string[]> {
  return reachedScripts(
    root,
    commit,
    await listTreeMatching(root, commit, HOOK_PATHSPECS),
    dorkHome
  );
}

/** What a trust card shows about a default-branch commit. */
export interface CandidateHooks {
  /** What a yes binds to: the commit and everything shown. */
  digest: string;
  /** The files shown, repo-relative. */
  files: string[];
  /** Their content, or the diff from the pinned commit. */
  detail: string;
}

/**
 * Describe what a yes on a trust card would let run: everything that counts at
 * `to`, or with `from` (a branch that moved forward), only what changed. Built
 * from the commit itself, so the worktree's own files never stand in for it.
 *
 * @param root - The repo's working tree top.
 * @param from - The pinned commit, or `null` to show everything at `to`.
 * @param to - The commit a yes would record.
 * @param dorkHome - DorkOS's data folder, whose `plugins/` scripts are not the repo's.
 */
export async function describeCandidate(
  root: string,
  from: string | null,
  to: string,
  dorkHome: string
): Promise<CandidateHooks> {
  const files: string[] = [];
  const diffs: string[] = [];
  const shown: [string, string][] = [];
  const labels = { before: 'pinned commit', after: 'default branch' };
  for (const counted of await countedPaths(root, from, to, dorkHome)) {
    const { before, after } = await sides(root, from, to, counted);
    if (after === null && before === null) continue;
    if (from !== null && before === after) continue;
    files.push(counted.rel);
    shown.push([counted.rel, after ?? 'removed']);
    diffs.push(fileDiff(counted.rel, before, after, labels));
  }
  return {
    digest: sha256(canonicalJson({ commit: to, shown })),
    files,
    detail: diffs.length > 0 ? diffs.join('\n\n') : 'The default branch runs no repo hooks.',
  };
}
