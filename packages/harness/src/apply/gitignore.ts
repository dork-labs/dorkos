/**
 * The `.gitignore` contract — the consumer `EPHEMERAL_GITIGNORE_PATTERNS` never
 * had (contract AP-09).
 *
 * Installed projections are machine-local: a skill symlink into a
 * plugin directory, a generated hooks file, the user-owned settings file the
 * engine merges into. Committing one hands a teammate a link to a file their
 * clone does not have. `sources/resolve-roots.ts` has always DECLARED which
 * patterns keep them out of git, and this repo mirrors them in its own
 * `.gitignore` by hand — but nothing ever checked a target repo, so a person
 * running `dorkos harness sync --fix` in a fresh project got a tree full of
 * untracked projections and no word about it.
 *
 * This module answers three questions, all of them off the finished plan rather
 * than on it: the plan is what decides which paths are ephemeral, so a field on
 * the plan would be the plan describing itself.
 *
 * 1. {@link missingGitignoreLines} — which lines this repo's root `.gitignore`
 *    is missing for the projections this plan makes.
 * 2. {@link appendGitignoreLines} — add them, append-only, under one comment.
 * 3. {@link canonicalLayerIgnoredBy} — whether `.agents/` itself is ignored, and
 *    by which file, since that changes what committing a projection even means
 *    (AP-15).
 *
 * **No `.git` directory, no answer.** Every function here returns the empty /
 * absent answer when the repo root holds no `.git`, because a `.gitignore` in a
 * directory git does not track is not a fact about anything, and telling
 * somebody to edit one would be noise.
 *
 * **The matcher walks the path the way git does.** A `.gitignore` is not a set
 * of patterns to test a path against — it is an ordered list applied per path
 * COMPONENT, where the last matching line wins and a `!` line un-ignores. Both
 * halves are load-bearing here, and a matcher that skipped `!` lines got the
 * common `dir/*` + `!dir/keep` idiom backwards in the dangerous direction: with
 * `.claude/*` and `!.claude/skills/` in a repo's file, git TRACKS
 * `.claude/skills/pkg__skill` and a negation-blind matcher called it covered,
 * so the one repo that needed the warning was the one that never got it. The
 * one rule git states that a naive last-match-wins misses is also implemented:
 * a file under an excluded DIRECTORY cannot be re-included, because git never
 * descends into it.
 *
 * What is deliberately small is the glob vocabulary: `*` within a segment, `**`
 * across segments, `?`, a trailing `/` for a directory, a leading `/` or an
 * embedded one for anchoring, a leading double-star segment and the bare-name rule for
 * "at any depth". `__tests__/gitignore.test.ts` checks the whole thing against
 * real `git check-ignore` on a real repo wherever git is on PATH, and asserts
 * that every pattern in the constant is a shape it understands.
 *
 * @module apply/gitignore
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.js';
import type { ProjectionPlan } from '../plan/types.js';
import { getActionContent } from '../plan/content-map.js';
import { EPHEMERAL_GITIGNORE_PATTERNS, isEphemeralProvenance } from '../sources/resolve-roots.js';
import { PROJECT_PLUGINS_DIR } from '../sources/installed.js';
import { GENERATED_SIDECAR_SUFFIX } from './generated-ownership.js';
import { GENERATED_HOOK_TARGET_HARNESSES } from '../generate/hooks.js';
import { HARNESS_MANIFEST_PATH } from '../scaffold/manifest.js';
import { AGENTS_SKILLS_DIR } from '../scan/scanner.js';

/** The repo's root `.gitignore`, the one file this module reads and appends to. */
const ROOT_GITIGNORE = '.gitignore';

/** The canonical layer's directory — `.agents`, the parent of `.agents/skills`. */
const CANONICAL_DIR = AGENTS_SKILLS_DIR.split('/')[0] as string;

/**
 * A path INSIDE the project install root, used to ask whether that root is
 * ignored.
 *
 * The install root is a directory, and the question worth asking is whether its
 * CONTENTS reach git, so it is asked of a path inside it. No package is named:
 * the answer is the same for every one of them.
 */
const INSTALL_ROOT_PROBE = `${PROJECT_PLUGINS_DIR}/any-package`;

/** The comment written above the lines {@link appendGitignoreLines} adds. */
const APPEND_HEADER = '# DorkOS harness sync — ephemeral projections';

/**
 * What is at the end of a path, as far as a `dir/` pattern is concerned.
 *
 * `'file'` covers a SYMLINK too, deliberately: git treats a link as a file
 * whatever it points at, so a `*__*` DIRECTORY rule does not ignore `.claude/skills/pkg__skill`
 * even though that link resolves to a directory. Both of the engine's `*__*`
 * families are links, so this is the difference between a repo being warned and
 * a repo committing its projections.
 */
export type LeafKind = 'dir' | 'file';

/**
 * Whether a repo-relative path is ignored by a whole `.gitignore` file's lines.
 *
 * Git's own procedure, as far as these paths need it: walk the path one
 * component at a time, and at each level let the LAST line that matches that
 * exact component decide — a `!` line deciding "not ignored". A component that
 * ends up ignored is a directory git never descends into, so everything under it
 * is ignored and cannot be re-included, which is the one rule a plain
 * last-match-wins over the full path would get wrong.
 *
 * Every component but the last is a directory by construction — git only
 * descends through directories — so a `dir/` line decides those. The LAST one is
 * whatever `leafKind` says, and getting that wrong is not academic: a repo
 * whose rule is a `*__*` DIRECTORY one has git tracking `.claude/skills/pkg__skill`, because that
 * projection is a symlink and git calls a link a file. The kind is passed in
 * rather than probed here so this stays pure and answers the same way for a
 * target the plan has not written yet.
 *
 * @param patterns - the file's lines, in order, blanks and comments removed.
 * @param relPath - a repo-relative, slash-separated path.
 * @param leafKind - what the last component is; a file by default, which is what
 *   every path this module asks about turns out to be but one.
 * @returns `true` when git would not track that path.
 */
export function isPathIgnored(
  patterns: readonly string[],
  relPath: string,
  leafKind: LeafKind = 'file'
): boolean {
  const segments = relPath.split('/').filter((segment) => segment !== '');
  let ignored = false;
  let prefix = '';
  for (const [index, segment] of segments.entries()) {
    // An excluded directory is never descended into, so nothing inside it can be
    // re-included — git says so, and it is why negation is a per-level answer.
    if (ignored) return true;
    prefix = prefix === '' ? segment : `${prefix}/${segment}`;
    const isDir = index < segments.length - 1 || leafKind === 'dir';
    for (const pattern of patterns) {
      const decision = decidePattern(pattern, prefix, isDir);
      if (decision !== undefined) ignored = decision;
    }
  }
  return ignored;
}

/**
 * Whether a repo-relative path is ignored by ONE `.gitignore` pattern.
 *
 * The single-pattern question, which is what "does the engine declare a line
 * that would cover this?" means. A `!` line ignores nothing on its own, so it
 * answers `false` here; negation only means something in the ordered list
 * {@link isPathIgnored} reads.
 *
 * @param pattern - one `.gitignore` line.
 * @param relPath - a repo-relative, slash-separated path.
 * @param leafKind - what the last component is; a file by default.
 * @returns `true` when the pattern ignores that path.
 */
export function gitignorePatternMatches(
  pattern: string,
  relPath: string,
  leafKind: LeafKind = 'file'
): boolean {
  return isPathIgnored([pattern], relPath, leafKind);
}

/**
 * What one pattern says about one path COMPONENT: ignore it, un-ignore it, or
 * nothing at all.
 *
 * Matching is exact against the component — the "and everything under it" half
 * belongs to {@link isPathIgnored}'s walk, not to the pattern. A `dir/` rule
 * says nothing about a component that is not a directory.
 */
function decidePattern(pattern: string, path: string, isDir: boolean): boolean | undefined {
  const trimmed = pattern.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return undefined;
  const negated = trimmed.startsWith('!');
  const rule = negated ? trimmed.slice(1) : trimmed;

  const dirOnly = rule.endsWith('/');
  if (dirOnly && !isDir) return undefined;
  let body = (dirOnly ? rule.slice(0, -1) : rule).replace(/^\//, '');
  // A leading double-star segment is git's own spelling of "at any depth", so it un-anchors
  // the rest rather than demanding a directory in front of it.
  const anyDepth = body.startsWith('**/');
  if (anyDepth) body = body.slice(3);
  if (body === '') return undefined;

  const anchored = !anyDepth && (rule.startsWith('/') || body.includes('/'));
  const prefix = anchored ? '^' : '^(?:.*/)?';
  return new RegExp(`${prefix}${globToRegExpBody(body)}$`).test(path) ? !negated : undefined;
}

/** Translate one glob body into a regular-expression body. */
function globToRegExpBody(body: string): string {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string;
    if (ch === '*') {
      if (body[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

/**
 * Every usable line of a `.gitignore` file, IN ORDER, or `[]` when there is none.
 *
 * Negations are kept: they are lines like any other, and the order they sit in
 * is what decides the answer (see {@link isPathIgnored}). Dropping them was the
 * bug — a repo whose file said `.claude/*` then `!.claude/skills/` was told its
 * projections were covered when git tracks them.
 */
function readGitignore(absPath: string): string[] {
  if (!existsSync(absPath)) return [];
  return readLines(readFileSync(absPath, 'utf8'));
}

/** Whether the repo root is a git checkout at all (a worktree's `.git` is a file). */
function isGitRepo(repoRoot: string): boolean {
  return existsSync(join(repoRoot, '.git'));
}

/**
 * Every repo-relative path this plan makes that git must not track.
 *
 * Three families, and the third is the one a provenance test alone would miss:
 *
 * - the TARGET of every installed projection — the skill links, the
 *   command wrappers, the settings file plugin hooks merge into;
 * - the SOURCE those read, which is the plugin install directory itself;
 * - the generated per-harness hooks files and their ownership sidecars. Their
 *   provenance is `authored` — the hooks come from `.claude/settings.json`, and
 *   that is the honest word for where they came FROM — but the file written is
 *   rewritten from scratch every sync and the sidecar is one machine's digest of
 *   one machine's bytes. The constant has always listed all six; AP-09 names
 *   them explicitly.
 */
function ephemeralPaths(plan: ProjectionPlan, repoRoot: string): EphemeralPath[] {
  const paths = new Map<string, LeafKind>();
  for (const action of plan.actions) {
    if (isEphemeralProvenance(action.provenance)) {
      if (action.source) paths.set(action.source, onDiskKind(repoRoot, action.source, 'file'));
      // A projection is a link or a written file, and git calls both a file —
      // which is what decides whether a `dir/` rule in the repo covers it.
      if (action.target && action.kind !== 'native') paths.set(action.target, 'file');
      continue;
    }
    if (action.target && action.target in GENERATED_HOOK_TARGET_HARNESSES) {
      paths.set(action.target, 'file');
      paths.set(`${action.target}${GENERATED_SIDECAR_SUFFIX}`, 'file');
    }
  }
  // The install directory itself, which no action names when a package
  // contributes only hooks — and which is the biggest thing here to commit by
  // accident. Probed on disk rather than inferred, because it belongs to the
  // marketplace installer, not to this plan.
  if (existsSync(join(repoRoot, PROJECT_PLUGINS_DIR))) paths.set(INSTALL_ROOT_PROBE, 'dir');
  return [...paths].map(([path, kind]) => ({ path, kind }));
}

/** One ephemeral path and what a `dir/` rule would see at the end of it. */
interface EphemeralPath {
  /** The repo-relative path. */
  path: string;
  /** What is (or will be) at its last component. */
  kind: LeafKind;
}

/**
 * What is at a path on disk, or `fallback` when nothing is there yet.
 *
 * `lstatSync`, never `statSync`: a symlink is a file to git whatever it resolves
 * to, and the two `*__*` families the engine writes are symlinks to directories.
 * Reading through them would say `dir` and hand a `*__*` directory rule a match
 * git does not make. Wrapped, because a path that cannot be read must not take
 * down a sync (the same lesson as `detectHarnessFootprints`).
 */
function onDiskKind(repoRoot: string, relPath: string, fallback: LeafKind): LeafKind {
  try {
    const stats = lstatSync(join(repoRoot, relPath), { throwIfNoEntry: false });
    if (!stats) return fallback;
    return stats.isDirectory() ? 'dir' : 'file';
  } catch {
    return fallback;
  }
}

/**
 * Whether the plan itself writes a `.gitignore` inside the target's own
 * directory that covers it.
 *
 * This is the command-wrapper case (`sources/resolve-roots.ts`): a static rule
 * for `.claude/commands/<pkg>/` would swallow authored `.claude/commands/<ns>/`
 * dirs, so each wrapper directory carries its own self-ignoring `.gitignore`,
 * and the shared flat `.opencode/commands/` dir carries one that names each
 * generated wrapper explicitly. Neither belongs in the root file.
 */
function selfIgnored(plan: ProjectionPlan, target: string): boolean {
  const slash = target.lastIndexOf('/');
  if (slash === -1) return false;
  const dir = target.slice(0, slash);
  const name = target.slice(slash + 1);
  const own = plan.actions.find((a) => a.target === `${dir}/${ROOT_GITIGNORE}`);
  if (!own) return false;
  if (name === ROOT_GITIGNORE) return true;
  const content = getActionContent(own);
  // A wrapper `.md` and the `.gitignore` beside it are both files.
  return content !== undefined && isPathIgnored(readLines(content), name, 'file');
}

/** The usable lines of a `.gitignore` body held in memory, in order. */
function readLines(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/**
 * The lines this repo's root `.gitignore` is missing for the plan's ephemeral
 * projections, in the order {@link EPHEMERAL_GITIGNORE_PATTERNS} declares them.
 *
 * A path already covered by ANY line in the file contributes nothing — a repo
 * that ignores all of `.claude/` is not told to add `.claude/skills/*__*` — and
 * neither does one covered by a self-ignoring `.gitignore` the plan writes
 * beside it. What is left is named with the pattern from the constant that
 * covers it, or, if the constant somehow covers it with nothing, with the path
 * itself, so the answer is always a line a person can paste. Property P7 is what
 * says that fallback never fires.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the plan whose projections are being checked.
 * @returns the missing lines, deduplicated; empty when nothing is missing, and
 *   empty when the root is not a git checkout.
 */
export function missingGitignoreLines(repoRoot: string, plan: ProjectionPlan): string[] {
  if (!isGitRepo(repoRoot)) return [];
  const present = readGitignore(join(repoRoot, ROOT_GITIGNORE));
  const missing = new Set<string>();

  for (const { path, kind } of ephemeralPaths(plan, repoRoot)) {
    if (isPathIgnored(present, path, kind)) continue;
    if (selfIgnored(plan, path)) continue;
    const covering = EPHEMERAL_GITIGNORE_PATTERNS.filter((pattern) =>
      gitignorePatternMatches(pattern, path, kind)
    );
    if (covering.length === 0) missing.add(path);
    else for (const pattern of covering) missing.add(pattern);
  }

  const declared = EPHEMERAL_GITIGNORE_PATTERNS as readonly string[];
  return [...missing].sort((a, b) => order(declared, a) - order(declared, b));
}

/** A pattern's position in the declared list; anything else sorts last. */
function order(declared: readonly string[], line: string): number {
  const at = declared.indexOf(line);
  return at === -1 ? declared.length : at;
}

/**
 * Add lines to the repo's root `.gitignore` under ONE DorkOS comment, creating
 * the file when there is none.
 *
 * Insert-only, never a rewrite: the file is the person's, it may carry ordering
 * that matters to them, and nothing here is a reason to touch a line they wrote.
 * A first run appends the comment and its lines at the end; a later run — a
 * `--harness codex` sync followed by a full one, say — extends the block that is
 * already there rather than stamping a second copy of the same heading down the
 * file.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param lines - the lines to add, already known to be missing.
 * @returns the repo-relative path written.
 */
export function appendGitignoreLines(repoRoot: string, lines: readonly string[]): string {
  const abs = join(repoRoot, ROOT_GITIGNORE);
  const existing = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
  // Atomic: this is a read-modify-write of a file git and every editor in the
  // repo also read, so a reader catching the truncate would see the person's
  // own ignore rules vanish rather than grow (`atomic-write.ts`).
  writeFileAtomic(abs, withGitignoreLines(existing, lines));
  return ROOT_GITIGNORE;
}

/**
 * The `.gitignore` body with `lines` added under the single DorkOS heading —
 * extending that block when it exists, appending it when it does not.
 *
 * Kept pure so the placement is testable without a filesystem, and because the
 * end of an existing block is the one thing here that is easy to get subtly
 * wrong: it runs to the first blank line, so a person's own lines below the
 * block stay below it.
 */
function withGitignoreLines(existing: string, lines: readonly string[]): string {
  if (existing.trim() === '') return `${APPEND_HEADER}\n${lines.join('\n')}\n`;

  const body = existing.endsWith('\n') ? existing.slice(0, -1) : existing;
  const rows = body.split('\n');
  const header = rows.indexOf(APPEND_HEADER);
  if (header === -1) return `${body}\n\n${APPEND_HEADER}\n${lines.join('\n')}\n`;

  let end = header + 1;
  while (end < rows.length && rows[end]?.trim() !== '') end += 1;
  rows.splice(end, 0, ...lines);
  return `${rows.join('\n')}\n`;
}

/**
 * Which `.gitignore` keeps `.agents/` — the canonical layer every projection is
 * made FROM — out of git, if any (contract AP-15).
 *
 * Some teams do ignore it, and it is not wrong, but it changes what the rest of
 * the engine's output means: the canonical skills and instructions become local
 * state on one computer, while the links written into `.claude/skills` are
 * ordinary committable files pointing into a directory a teammate's clone will
 * not have.
 *
 * The FILE is the answer rather than a boolean, because "stop ignoring it" is
 * advice a person can only act on once they know which of the two files to open
 * — and the second one, `.agents/.gitignore`, is easy to forget you wrote.
 *
 * Asked of `.agents/harness.manifest.json` rather than of the directory, so the
 * two `*__*` patterns — which ignore only installed projections inside it — are
 * never mistaken for ignoring the layer.
 *
 * @param repoRoot - absolute path to the repository root.
 * @returns the repo-relative path of the `.gitignore` that ignores the canonical
 *   layer, or `undefined` when git would track it (and when this is not a git
 *   checkout at all).
 */
export function canonicalLayerIgnoredBy(repoRoot: string): string | undefined {
  if (!isGitRepo(repoRoot)) return undefined;
  const probe = HARNESS_MANIFEST_PATH;
  // The probe is the manifest FILE; `.agents/` still matches at the directory
  // component in front of it, which is the question being asked.
  if (isPathIgnored(readGitignore(join(repoRoot, ROOT_GITIGNORE)), probe, 'file')) {
    return ROOT_GITIGNORE;
  }

  const ownPath = `${CANONICAL_DIR}/${ROOT_GITIGNORE}`;
  const own = readGitignore(join(repoRoot, ownPath));
  const withinCanonical = probe.slice(`${CANONICAL_DIR}/`.length);
  return isPathIgnored(own, withinCanonical, 'file') ? ownPath : undefined;
}
