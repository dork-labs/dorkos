/**
 * The `.gitignore` contract — the consumer `EPHEMERAL_GITIGNORE_PATTERNS` never
 * had (contract AP-09).
 *
 * Installed and adopted projections are machine-local: a skill symlink into a
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
 * 3. {@link isCanonicalLayerIgnored} — whether `.agents/` itself is ignored,
 *    which changes what committing a projection even means (AP-15).
 *
 * **No `.git` directory, no answer.** Every function here returns the empty /
 * false answer when the repo root holds no `.git`, because a `.gitignore` in a
 * directory git does not track is not a fact about anything, and telling
 * somebody to edit one would be noise.
 *
 * **The matcher is deliberately small.** Git's ignore semantics are large; the
 * patterns under test are not (a directory prefix, a `*__*` glob under one
 * directory, a handful of exact file paths). So it implements the shapes those
 * take — `*`, `**`, a trailing `/`, a leading `/`, and the bare-name rule — and
 * `__tests__/gitignore.test.ts` asserts that every pattern in the constant is a
 * shape it understands, so a pattern added in a shape it does not is a red
 * rather than a silent miss. It does NOT implement negation: a `!` line is
 * skipped, so a repo that re-includes an ephemeral path is told nothing rather
 * than told something wrong.
 *
 * @module apply/gitignore
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
 * A `dir/` pattern ignores what is in a directory, never the directory's own
 * path, so the question has to be asked of something inside it. No package is
 * named: the answer is the same for every one of them.
 */
const INSTALL_ROOT_PROBE = `${PROJECT_PLUGINS_DIR}/any-package`;

/** The comment written above the lines {@link appendGitignoreLines} adds. */
const APPEND_HEADER = '# DorkOS harness sync — ephemeral projections';

/**
 * Whether a repo-relative path is ignored by a `.gitignore` pattern.
 *
 * Supported shapes, which is all the constant uses and nearly all a person
 * writes for these paths:
 *
 * - `dir/` — that directory and everything under it.
 * - `a/b/c` — that exact path, and anything under it if it is a directory.
 * - `*` within a segment (`skills/*__*`), `**` across segments.
 * - a pattern with no `/` matches that name at ANY depth, as git does.
 * - a leading `/` anchors to the repo root, which these paths already are.
 *
 * @param pattern - one `.gitignore` line, already stripped of comments/blanks.
 * @param relPath - a repo-relative, slash-separated path.
 * @returns `true` when the pattern ignores that path.
 */
export function gitignorePatternMatches(pattern: string, relPath: string): boolean {
  const trimmed = pattern.trim();
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('!')) return false;

  const dirOnly = trimmed.endsWith('/');
  const body = (dirOnly ? trimmed.slice(0, -1) : trimmed).replace(/^\//, '');
  if (body === '') return false;

  const anchored = trimmed.startsWith('/') || body.includes('/');
  const prefix = anchored ? '^' : '^(?:.*/)?';
  // A directory pattern never matches the directory's own path — only what is
  // inside it. Anything else matches the path itself, or anything beneath it.
  const suffix = dirOnly ? '/.*$' : '(?:/.*)?$';
  return new RegExp(`${prefix}${globToRegExpBody(body)}${suffix}`).test(relPath);
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

/** Every usable pattern in a `.gitignore` file, or `[]` when there is none. */
function readGitignore(absPath: string): string[] {
  if (!existsSync(absPath)) return [];
  return readFileSync(absPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('!'));
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
 * - the TARGET of every installed/adopted projection — the skill links, the
 *   command wrappers, the settings file plugin hooks merge into;
 * - the SOURCE those read, which is the plugin install directory itself;
 * - the generated per-harness hooks files and their ownership sidecars. Their
 *   provenance is `authored` — the hooks come from `.claude/settings.json`, and
 *   that is the honest word for where they came FROM — but the file written is
 *   rewritten from scratch every sync and the sidecar is one machine's digest of
 *   one machine's bytes. The constant has always listed all six; AP-09 names
 *   them explicitly.
 */
function ephemeralPaths(plan: ProjectionPlan, repoRoot: string): string[] {
  const paths = new Set<string>();
  for (const action of plan.actions) {
    if (isEphemeralProvenance(action.provenance)) {
      if (action.source) paths.add(action.source);
      if (action.target && action.kind !== 'native') paths.add(action.target);
      continue;
    }
    if (action.target && action.target in GENERATED_HOOK_TARGET_HARNESSES) {
      paths.add(action.target);
      paths.add(`${action.target}${GENERATED_SIDECAR_SUFFIX}`);
    }
  }
  // The install directory itself, which no action names when a package
  // contributes only hooks — and which is the biggest thing here to commit by
  // accident. Probed on disk rather than inferred, because it belongs to the
  // marketplace installer, not to this plan.
  if (existsSync(join(repoRoot, PROJECT_PLUGINS_DIR))) paths.add(INSTALL_ROOT_PROBE);
  return [...paths];
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
  return content !== undefined && readLines(content).some((p) => gitignorePatternMatches(p, name));
}

/** The usable pattern lines of a `.gitignore` body held in memory. */
function readLines(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('!'));
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

  for (const path of ephemeralPaths(plan, repoRoot)) {
    if (present.some((pattern) => gitignorePatternMatches(pattern, path))) continue;
    if (selfIgnored(plan, path)) continue;
    const covering = EPHEMERAL_GITIGNORE_PATTERNS.filter((pattern) =>
      gitignorePatternMatches(pattern, path)
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
 * Append lines to the repo's root `.gitignore`, under one comment, creating the
 * file when there is none.
 *
 * Append-only on purpose: the file is the person's, it may carry ordering that
 * matters to them, and nothing here is ever a reason to rewrite a line they
 * wrote. The existing bytes are preserved exactly, with a newline added first if
 * the file did not end with one.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param lines - the lines to add, already known to be missing.
 * @returns the repo-relative path written.
 */
export function appendGitignoreLines(repoRoot: string, lines: readonly string[]): string {
  const abs = join(repoRoot, ROOT_GITIGNORE);
  const existing = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
  const head = existing === '' ? '' : existing.endsWith('\n') ? `${existing}\n` : `${existing}\n\n`;
  writeFileSync(abs, `${head}${APPEND_HEADER}\n${lines.join('\n')}\n`);
  return ROOT_GITIGNORE;
}

/**
 * Whether `.agents/` — the canonical layer every projection is made FROM — is
 * itself ignored by git (contract AP-15).
 *
 * Some teams do ignore it, and it is not wrong, but it changes what the rest of
 * the engine's output means: the canonical skills and instructions become local
 * state on one computer, while the links written into `.claude/skills` are
 * ordinary committable files pointing into a directory a teammate's clone will
 * not have.
 *
 * Asked of `.agents/harness.manifest.json` rather than of the directory, so the
 * two `*__*` patterns — which ignore only installed projections inside it — are
 * never mistaken for ignoring the layer. A `.agents/.gitignore` that ignores its
 * own directory counts too.
 *
 * @param repoRoot - absolute path to the repository root.
 * @returns `true` when git would not track the canonical layer.
 */
export function isCanonicalLayerIgnored(repoRoot: string): boolean {
  if (!isGitRepo(repoRoot)) return false;
  const probe = HARNESS_MANIFEST_PATH.split(/[\\/]/).join('/');
  const root = readGitignore(join(repoRoot, ROOT_GITIGNORE));
  if (root.some((pattern) => gitignorePatternMatches(pattern, probe))) return true;

  const own = readGitignore(join(repoRoot, CANONICAL_DIR, ROOT_GITIGNORE));
  const withinCanonical = probe.slice(`${CANONICAL_DIR}/`.length);
  return own.some((pattern) => gitignorePatternMatches(pattern, withinCanonical));
}
