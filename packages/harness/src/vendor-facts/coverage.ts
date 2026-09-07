/**
 * The coverage walk — "what would this harness actually find in this tree?"
 *
 * The projection engine's tests are strong on file shape ("a symlink exists at
 * `.claude/skills/x`") and weak on truth ("Claude Code would load it"). This
 * module closes that gap from the other side: it walks a **real** directory the
 * way {@link ./index.js#HARNESS_VENDOR_FACTS | the vendor-facts table} says a
 * harness walks it, and reports what that harness's documented rules would
 * discover. It is the oracle a projection is measured against, so it must never
 * learn anything from the projector: it imports the facts, `HarnessId`, and the
 * skills frontmatter parser, and nothing from `plan/` or `apply/`.
 *
 * **The rule that makes it honest: every skill lands in exactly one list.**
 * `discovered` is a confident claim — this harness's own documentation is enough
 * to say it loads, and under this key. `uncertain` is the refusal to make one:
 * the outcome turns on a cell the vendor never documented, so the skill is
 * neither counted nor dropped. A consumer may therefore read `discovered` alone
 * and trust it. The six ways a skill becomes uncertain:
 *
 * - it was reached through a **symlink** and the harness does not document
 *   whether it follows them;
 * - the harness's **identity** rule is unknown and the directory name and the
 *   frontmatter name disagree, so the key would differ between the two readings;
 * - the harness keys on the **frontmatter name** and the `SKILL.md` has none;
 * - a documented **name rule** is broken and the harness does not document what
 *   it does about it (`onInvalidName: 'unknown'`);
 * - the harness requires (or might require) the name to **match the directory**
 *   and it cannot be checked, or does not match and the requirement is unstated;
 * - one skill is reachable **twice** and the harness does not document whether it
 *   loads once or twice — here the first copy reached is still a confident
 *   discovery, and only each later copy is uncertain.
 *
 * An assertion therefore reads "`discovered` contains what we projected **and**
 * `uncertain` is empty", so a gap in the table fails loudly instead of becoming
 * a confident wrong answer.
 *
 * **On a tree DorkOS has already projected into, `uncertain` is not empty, and
 * that is not a failure.** The engine's whole skills projection is a symlink
 * into `.claude/skills`, and three of the six harnesses do not document whether
 * they follow one — so on this repo's own worktree cursor, opencode and copilot
 * each report 31 discovered and 18 uncertain, every one of the 18 a symlink
 * reason for a skill they also reach as a real directory under `.agents/skills`.
 * The assertion for a projected tree is therefore the weaker, still-honest one:
 * `uncertain` is empty **or** holds only symlink-reason entries whose skill also
 * appears in `discovered` by another path. Anything else — an unknown identity
 * rule, an unnamed skill, a broken name rule, a second copy — is a real finding.
 * DOR-1847's false-native work leans on exactly that shape.
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
 * Three values in the facts vocabulary have no row today and so no fixture here:
 * `dedupe: 'by-name'`, `onInvalidName: 'skip'` and `onInvalidName: 'warn-and-load'`.
 * That is asserted rather than assumed — `vendor-facts.test.ts` censuses every
 * behaviour cell, so the first row to use one of them reds a test and the author
 * has to bring a fixture with it.
 *
 * @module vendor-facts/coverage
 */
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs';
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
 * One skill this walk refuses to decide about, because the vendor did not
 * document the thing the outcome turns on.
 *
 * An uncertain skill is **never** also a discovered one: the two lists partition
 * what the walk found, so `discovered` can be read on its own as a confident
 * claim. The one case that looks like an exception is not: when a skill is
 * reachable twice under an unknown dedupe rule, the first copy reached is a
 * confident discovery and each *later* copy is the uncertain entry.
 */
export interface Uncertain {
  /** Absolute path of the directory whose outcome is undecidable. */
  path: string;
  /** Which unknown cell made it undecidable, in plain words. */
  reason: string;
}

/** What {@link harnessCoverage} reports about a tree. */
export interface CoverageResult {
  /** Everything the harness's documented rules are enough to say it loads, in walk order. */
  discovered: DiscoveredSkill[];
  /** Everything whose outcome depends on a cell the vendor never documented. */
  uncertain: Uncertain[];
}

/** Options for {@link harnessCoverage}. */
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
 * `lstatSync` that answers `undefined` instead of throwing — the entry itself,
 * not what it points at, which is how the walk tells a symlink from a directory.
 *
 * @param path - absolute path to stat.
 * @returns the stats of the entry, or `undefined` when it cannot be read.
 */
function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path, { throwIfNoEntry: false });
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

/** A candidate discovery plus whatever made its outcome undecidable. */
interface Candidate {
  /** The discovery, if the harness's documented rules are enough to claim it. */
  found: DiscoveredSkill;
  /** Reasons the outcome is undecidable; each becomes an {@link Uncertain}. */
  reasons: string[];
  /** Whether the documented rules are enough to say it loads. Never true when `reasons` is non-empty. */
  loads: boolean;
}

/**
 * Apply one harness's symlink, identity and name rules to one skill directory.
 *
 * @param harness - the harness whose rules apply, named in the message text.
 * @param facts - its skills facts.
 * @param dir - absolute path of the skill directory.
 * @param skillMd - absolute path of the `SKILL.md` inside it.
 * @param via - the read path it was found through.
 * @param reachedThroughSymlink - whether the entry in the read path is a symlink rather than a directory.
 * @returns the candidate discovery, its key, and any undecidable outcome.
 */
function evaluate(
  harness: HarnessId,
  facts: SkillsFacts,
  dir: string,
  skillMd: string,
  via: string,
  reachedThroughSymlink: boolean
): Candidate {
  const dirName = basename(dir);
  const name = frontmatterName(skillMd);
  const reasons: string[] = [];

  if (reachedThroughSymlink && facts.symlinks === 'unknown') {
    reasons.push(
      `it is reached through a symlink, and ${harness} does not document whether it follows one`
    );
  }

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

  // A broken name rule with a DOCUMENTED consequence is not uncertainty: 'skip'
  // drops the skill outright and 'warn-and-load' loads it. Only 'unknown' is a
  // refusal to decide, and it joins the reasons above.
  let droppedByRule = false;
  if (violations.length > 0) {
    if (facts.onInvalidName === 'skip') {
      droppedByRule = true;
    } else if (facts.onInvalidName === 'unknown') {
      for (const violation of violations) {
        reasons.push(
          `${violation}, and ${harness} does not document what it does with such a skill`
        );
      }
    }
  }

  return {
    found: { key, dir, skillMd, via },
    reasons,
    loads: reasons.length === 0 && !droppedByRule,
  };
}

/**
 * Collapse candidates according to the harness's documented dedupe rule.
 *
 * `by-realpath` and `by-name` keep the first candidate in walk order and drop the
 * rest silently, because the vendor documents the merge. `none` is Codex's
 * explicit "duplicates are NOT merged - both appear", so both stay and nothing is
 * uncertain. `unknown` keeps the **first** copy reached — that one loads whatever
 * the answer turns out to be — and moves each later copy to `uncertain`, since
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
  if (facts.dedupe === 'none') return candidates;

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
    const kept: DiscoveredSkill[] = [];
    const firstByRealpath = new Map<string, DiscoveredSkill>();
    const firstByKey = new Map<string, DiscoveredSkill>();
    for (const candidate of candidates) {
      const realpath = realpathOf(candidate.dir);
      const first = firstByRealpath.get(realpath) ?? firstByKey.get(candidate.key);
      if (first) {
        uncertain.push({
          path: candidate.dir,
          reason: `one skill is reachable at ${viaOf(root, first.dir)} and ${viaOf(root, candidate.dir)}, and ${harness} does not document whether it loads once or twice`,
        });
        continue;
      }
      firstByRealpath.set(realpath, candidate);
      firstByKey.set(candidate.key, candidate);
      kept.push(candidate);
    }
    return kept;
  }

  // A fifth dedupe value has to fail the TYPE here, not fall through to some
  // behaviour nobody chose: reaching `unknown` by exhaustion would have made a
  // new value silently mean "keep everything", which is the confident answer
  // this module exists to refuse.
  const unhandled: never = facts.dedupe;
  throw new Error(`unhandled dedupe rule: ${String(unhandled)}`);
}

/**
 * What a harness's documented rules would discover in a real tree.
 *
 * Walks `root` the way {@link ./index.js#HARNESS_VENDOR_FACTS} says `harness`
 * walks it, treating every directory that directly contains a `SKILL.md` as a
 * skill, and applying that harness's symlink, identity, name and dedupe rules.
 * Every skill lands in exactly one of the two returned lists: `discovered` when
 * the harness's own documentation is enough to claim it loads, `uncertain` when
 * the answer depends on a cell the vendor never wrote down.
 *
 * @param harness - the harness to model.
 * @param root - absolute path of the tree to walk (a repo checkout, an agent workspace).
 * @param opts - walk options; see {@link CoverageOptions}.
 * @returns what the harness would find, and what cannot be decided from its docs.
 */
export function harnessCoverage(
  harness: HarnessId,
  root: string,
  opts?: CoverageOptions
): CoverageResult {
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
      // Resolve through symlinks to decide whether there is a skill here at all
      // (a dangling link is nothing); remember that it WAS a link, because on
      // four of the six harnesses that is itself an undocumented question.
      if (!statOrUndefined(dir)?.isDirectory()) continue;
      const skillMd = join(dir, 'SKILL.md');
      if (!statOrUndefined(skillMd)?.isFile()) continue;
      const reachedThroughSymlink = lstatOrUndefined(dir)?.isSymbolicLink() === true;

      const { found, reasons, loads } = evaluate(
        harness,
        facts,
        dir,
        skillMd,
        via,
        reachedThroughSymlink
      );
      for (const reason of reasons) uncertain.push({ path: dir, reason });
      if (loads) candidates.push(found);
    }
  }

  return {
    discovered: applyDedupe(harness, facts, absRoot, candidates, uncertain),
    uncertain,
  };
}
