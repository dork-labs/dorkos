/**
 * The coverage walk — "what would this harness actually find in this tree?"
 *
 * The projection engine's tests are strong on file shape ("a symlink exists at
 * `.claude/skills/x`") and weak on truth ("Claude Code would load it"). This
 * module closes that gap from the other side: it walks a **real** directory the
 * way {@link ../index.js#HARNESS_VENDOR_FACTS | the vendor-facts table} says a
 * harness walks it, and reports what that harness's documented rules would
 * discover. It is the oracle a projection is measured against, so it must never
 * learn anything from the projector: it imports the facts, `HarnessId`, and the
 * skills frontmatter parser, and nothing from `plan/` or `apply/`.
 *
 * The second half of the contract is {@link Uncertain}. Several cells in the
 * facts table are `unknown` because a vendor page did not say — what Cursor does
 * with a name that breaks its own charset rule, whether Copilot loads one skill
 * or two when it is reachable twice. Wherever an outcome depends on such a cell,
 * this walk refuses to guess: the entry lands in `uncertain` instead of being
 * quietly counted or quietly dropped. An assertion therefore reads "`discovered`
 * contains what we projected **and** `uncertain` is empty", and a gap in the
 * table fails loudly rather than becoming a confident wrong answer.
 *
 * Two scope limits, both deliberate:
 *
 * - **Project scope only.** `readPaths.user` is data for humans; nothing here
 *   walks a home directory.
 * - **Claude Code's lazy nested tier is not modelled.** It ascends *and* loads a
 *   nested `<subdir>/.claude/skills` under a directory-qualified name when a file
 *   there is touched, which no static walk can express (SK-15). The test plan
 *   (§2, T1c) puts it out of scope on purpose rather than inventing a fourth walk.
 *
 * @module vendor-facts/coverage
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, type Stats } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readRawFrontmatter } from '@dorkos/skills/parser';
import type { HarnessId } from '../manifest/schema.js';
import { skillsFactsFor } from './index.js';
import type { SkillsFacts } from './types.js';

/** One skill a harness's documented read paths and rules would find. */
export interface DiscoveredSkill {
  /** The identifier this harness would key the skill by (its directory or its frontmatter `name`). */
  key: string;
  /** Absolute path of the skill directory as it was reached (a symlink stays a symlink). */
  dir: string;
  /** Absolute path of the `SKILL.md` inside it. */
  skillMd: string;
  /** The read path it was found through, relative to the walked root, POSIX-separated. */
  via: string;
}

/**
 * One thing this walk refuses to decide, because the vendor did not document it.
 *
 * An `uncertain` entry is never also a `discovered` one, except for the dedupe
 * case: when a harness's dedupe rule is `unknown`, both copies stay discovered
 * AND an `uncertain` entry says the count may be one or two.
 */
export interface Uncertain {
  /** Absolute path of the directory whose outcome is undecidable. */
  path: string;
  /** Which unknown cell made it undecidable, in plain words. */
  reason: string;
}

/** What {@link coverage} reports about a tree. */
export interface CoverageResult {
  /** Everything the harness's documented rules would load, in walk order. */
  discovered: DiscoveredSkill[];
  /** Everything whose outcome depends on a cell the vendor never documented. */
  uncertain: Uncertain[];
}

/** Options for {@link coverage}. */
export interface CoverageOptions {
  /**
   * The directory a session would start in, for the two ascending walks.
   *
   * Defaults to `root`, and is ignored by the `fixed` and `descend-recursive`
   * walks, which do not depend on where a session started. A `cwd` outside
   * `root` is treated as `root`.
   */
  cwd?: string;
}

/** Directories no descending walk ever enters. */
const NEVER_DESCEND = new Set(['node_modules', '.git']);

/**
 * How deep a `descend-recursive` walk goes below the root.
 *
 * A bound, not a claim: Cursor documents a recursive scan with no stated limit,
 * and an unbounded walk over a real monorepo is a test that takes minutes.
 */
const MAX_DESCEND_DEPTH = 6;

/**
 * `statSync` that follows symlinks and answers `undefined` instead of throwing.
 *
 * A dangling symlink, a permission error and a symlink loop all mean the same
 * thing to this walk: there is nothing loadable here.
 *
 * @param path - absolute path to stat.
 * @returns the stats, or `undefined` when the path cannot be resolved.
 */
function statOrUndefined(path: string): Stats | undefined {
  try {
    return statSync(path, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

/**
 * Read a `SKILL.md`'s frontmatter `name`.
 *
 * @param skillMd - absolute path to the `SKILL.md`.
 * @returns the trimmed name, or `undefined` when it is absent, empty, not a string, or unreadable.
 */
function frontmatterName(skillMd: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(skillMd, 'utf8');
  } catch {
    return undefined;
  }
  const name = readRawFrontmatter(raw)?.data.name;
  if (typeof name !== 'string') return undefined;
  const trimmed = name.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** A directory the walk will look for read paths in. */
interface ReadDir {
  /** Absolute path of the read directory. */
  abs: string;
  /** Its path relative to the walked root, POSIX-separated. */
  via: string;
}

/**
 * Express `abs` relative to `root` with forward slashes.
 *
 * @param root - absolute root of the walk.
 * @param abs - absolute path at or below it.
 * @returns the POSIX-style relative path.
 */
function viaOf(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/');
}

/**
 * The directory levels an ascending walk visits, nearest first.
 *
 * Starts at `cwd` and climbs, bounded at `root` in every case. When
 * `stopAtWorktree` is set the climb also stops at the first level holding a
 * `.git` entry (file or directory, so a linked worktree counts) — and `root` is
 * the stop when no level has one, which is the documented fallback for a tree
 * that is not a git checkout.
 *
 * @param root - absolute root of the walk; the climb never goes above it.
 * @param cwd - absolute start directory; treated as `root` when it is outside it.
 * @param stopAtWorktree - whether a `.git` entry ends the climb.
 * @returns the levels to visit, from `cwd` up to the stop, inclusive.
 */
function ascendLevels(root: string, cwd: string, stopAtWorktree: boolean): string[] {
  const rel = relative(root, cwd);
  const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  let current = inside ? cwd : root;

  const levels: string[] = [];
  for (;;) {
    levels.push(current);
    if (stopAtWorktree && existsSync(join(current, '.git'))) break;
    if (current === root) break;
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }
  return levels;
}

/**
 * Every directory a `descend-recursive` walk treats as a scope root.
 *
 * The root itself, then every subdirectory down to {@link MAX_DESCEND_DEPTH},
 * skipping `node_modules`, `.git`, and dot-directories that are not the first
 * segment of one of this harness's own read paths. Symlinked subdirectories are
 * not descended into — following them turns a cycle into a hang, and no vendor
 * documents recursing through them.
 *
 * @param root - absolute root of the walk.
 * @param facts - the harness's skills facts, for the set of listed dot-directories.
 * @returns the scope roots, root first, each level in name order.
 */
function descendScopes(root: string, facts: SkillsFacts): string[] {
  const listedDotDirs = new Set(
    facts.readPaths.project.map((p) => p.split('/')[0]).filter((s) => s.startsWith('.'))
  );

  const scopes: string[] = [];
  const visit = (dir: string, depth: number): void => {
    scopes.push(dir);
    if (depth >= MAX_DESCEND_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      if (NEVER_DESCEND.has(entry.name)) continue;
      if (entry.name.startsWith('.') && !listedDotDirs.has(entry.name)) continue;
      visit(join(dir, entry.name), depth + 1);
    }
  };
  visit(root, 0);
  return scopes;
}

/**
 * The read directories this harness would consult, in the order it consults them.
 *
 * @param facts - the harness's skills facts.
 * @param root - absolute root of the walk.
 * @param cwd - absolute start directory for the ascending walks.
 * @returns one entry per (level x declared read path), duplicates removed.
 */
function readDirs(facts: SkillsFacts, root: string, cwd: string): ReadDir[] {
  const scopes =
    facts.walk === 'descend-recursive'
      ? descendScopes(root, facts)
      : facts.walk === 'fixed'
        ? [root]
        : ascendLevels(root, cwd, facts.walk === 'ascend-to-worktree');

  const dirs: ReadDir[] = [];
  const seen = new Set<string>();
  for (const scope of scopes) {
    for (const readPath of facts.readPaths.project) {
      const abs = join(scope, readPath);
      if (seen.has(abs)) continue;
      seen.add(abs);
      dirs.push({ abs, via: viaOf(root, abs) });
    }
  }
  return dirs;
}

/** A candidate discovery plus the uncertainty its identity and name rules produced. */
interface Candidate {
  /** The discovery, if the harness's rules let it load. */
  found: DiscoveredSkill;
  /** Reasons this entry's outcome is undecidable; each becomes an {@link Uncertain}. */
  reasons: string[];
  /** Whether the documented rules let it load at all. */
  loads: boolean;
}

/**
 * Apply one harness's identity and name rules to one skill directory.
 *
 * @param harness - the harness whose rules apply, named in the message text.
 * @param facts - its skills facts.
 * @param dir - absolute path of the skill directory.
 * @param skillMd - absolute path of the `SKILL.md` inside it.
 * @param via - the read path it was found through.
 * @returns the candidate discovery, its key, and any undecidable outcome.
 */
function evaluate(
  harness: HarnessId,
  facts: SkillsFacts,
  dir: string,
  skillMd: string,
  via: string
): Candidate {
  const dirName = basename(dir);
  const name = frontmatterName(skillMd);
  const reasons: string[] = [];

  let key = dirName;
  if (facts.identity === 'frontmatter') {
    if (name === undefined) {
      reasons.push(
        `frontmatter name absent, and ${harness} keys a skill by its frontmatter name - the directory name "${dirName}" is a fallback, not what the harness would use`
      );
    } else {
      key = name;
    }
  } else if (facts.identity === 'unknown' && name !== undefined && name !== dirName) {
    reasons.push(
      `${harness} does not document whether a skill is keyed by its directory ("${dirName}") or its frontmatter name ("${name}"), and the two differ`
    );
  }

  const violations: string[] = [];
  if (facts.nameRegex && !facts.nameRegex.test(key)) {
    violations.push(
      `the name "${key}" breaks ${harness}'s documented charset rule ${String(facts.nameRegex)}`
    );
  }
  if (facts.nameMustMatchDir === true) {
    if (name === undefined) {
      reasons.push(
        `${harness} documents that a skill's frontmatter name must match its directory, and this SKILL.md has no name`
      );
    } else if (name !== dirName) {
      violations.push(
        `the frontmatter name "${name}" does not match the directory "${dirName}", which ${harness} documents as required`
      );
    }
  } else if (facts.nameMustMatchDir === 'unknown' && name !== undefined && name !== dirName) {
    reasons.push(
      `the frontmatter name "${name}" does not match the directory "${dirName}", and ${harness} does not document whether it must`
    );
  }

  let loads = true;
  if (violations.length > 0) {
    if (facts.onInvalidName === 'skip') {
      loads = false;
    } else if (facts.onInvalidName === 'unknown') {
      loads = false;
      for (const violation of violations) {
        reasons.push(
          `${violation}, and ${harness} does not document what it does with such a skill`
        );
      }
    }
    // 'warn-and-load' is a documented outcome, not an uncertainty: it loads.
  }

  return { found: { key, dir, skillMd, via }, reasons, loads };
}

/**
 * Collapse candidates according to the harness's documented dedupe rule.
 *
 * `by-realpath` and `by-name` keep the first candidate in walk order. `none` is
 * Codex's explicit "duplicates are NOT merged - both appear", so both stay and
 * nothing is uncertain. `unknown` keeps both AND reports the ambiguity, since
 * "one or two" is exactly the question the vendor left open.
 *
 * @param harness - the harness whose rule applies, named in the message text.
 * @param facts - its skills facts.
 * @param root - absolute root of the walk, for readable paths in the message.
 * @param candidates - the loadable discoveries, in walk order.
 * @param uncertain - sink for ambiguities this rule produces.
 * @returns the discoveries that survive the rule.
 */
function applyDedupe(
  harness: HarnessId,
  facts: SkillsFacts,
  root: string,
  candidates: DiscoveredSkill[],
  uncertain: Uncertain[]
): DiscoveredSkill[] {
  const realpathOf = (dir: string): string => {
    try {
      return realpathSync(dir);
    } catch {
      return dir;
    }
  };

  if (facts.dedupe === 'by-name' || facts.dedupe === 'by-realpath') {
    const kept: DiscoveredSkill[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const id = facts.dedupe === 'by-name' ? candidate.key : realpathOf(candidate.dir);
      if (seen.has(id)) continue;
      seen.add(id);
      kept.push(candidate);
    }
    return kept;
  }

  if (facts.dedupe === 'unknown') {
    const groups = new Map<string, DiscoveredSkill[]>();
    for (const candidate of candidates) {
      for (const id of [`realpath:${realpathOf(candidate.dir)}`, `key:${candidate.key}`]) {
        const group = groups.get(id) ?? [];
        group.push(candidate);
        groups.set(id, group);
      }
    }
    const reported = new Set<string>();
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      const paths = members.map((m) => viaOf(root, m.dir)).sort();
      const signature = paths.join(' ');
      if (reported.has(signature)) continue;
      reported.add(signature);
      uncertain.push({
        path: members[0].dir,
        reason: `one skill is reachable at ${paths.join(' and ')}, and ${harness} does not document whether it loads once or twice`,
      });
    }
  }

  return candidates;
}

/**
 * What a harness's documented rules would discover in a real tree.
 *
 * Walks `root` the way {@link ../index.js#HARNESS_VENDOR_FACTS} says `harness`
 * walks it, treating every directory that directly contains a `SKILL.md` as a
 * skill, and applying that harness's identity, name and dedupe rules. Anything
 * whose outcome depends on a cell the vendor never documented is reported in
 * `uncertain` instead of being guessed either way.
 *
 * @param harness - the harness to model.
 * @param root - absolute path of the tree to walk (a repo checkout, an agent workspace).
 * @param opts - walk options; see {@link CoverageOptions}.
 * @returns what the harness would find, and what cannot be decided from its docs.
 */
export function coverage(harness: HarnessId, root: string, opts?: CoverageOptions): CoverageResult {
  const facts = skillsFactsFor(harness);
  const absRoot = resolve(root);
  const cwd = resolve(opts?.cwd ?? absRoot);

  const uncertain: Uncertain[] = [];
  const candidates: DiscoveredSkill[] = [];

  for (const { abs, via } of readDirs(facts, absRoot, cwd)) {
    if (!existsSync(abs)) continue;
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const dir = join(abs, entry.name);
      // Follow symlinks - every harness that documents them follows them, and a
      // dangling one is nothing at all.
      if (!statOrUndefined(dir)?.isDirectory()) continue;
      const skillMd = join(dir, 'SKILL.md');
      if (!statOrUndefined(skillMd)?.isFile()) continue;

      const { found, reasons, loads } = evaluate(harness, facts, dir, skillMd, via);
      for (const reason of reasons) uncertain.push({ path: dir, reason });
      if (loads) candidates.push(found);
    }
  }

  return {
    discovered: applyDedupe(harness, facts, absRoot, candidates, uncertain),
    uncertain,
  };
}
