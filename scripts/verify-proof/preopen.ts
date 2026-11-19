import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The lighter checks `pnpm verify:preopen` runs before a PR opens (DOR-4728).
 *
 * The full `pnpm verify` runs four steps. Preopen keeps the one that catches the
 * most, the affected typecheck and lint, and narrows the rest:
 *
 *   test:scripts      the whole scripts suite, when the change can reach it (the
 *                     scope `scripts/scripts-test-scope.sh` holds, plus `.agents/`,
 *                     `.claude/`, `.github/` and the root `package.json`)
 *   scripts-repo      otherwise, the repo-wide scripts suites alone
 *                     (`scripts/vitest.repo.config.ts`): they read the whole tree, so
 *                     any change can break them, and the required `typecheck`
 *                     workflow runs them on every PR
 *   lint:changed      ESLint on the changed files from the root, in place of `eslint .`
 *   lint:root         the full `eslint .`, when the root lint setup itself changed or
 *                     too many files did to list
 *   typecheck-lint    `pnpm verify:preopen:turbo`, the same lock, base pin and heap
 *                     as the full gate's typecheck and lint step
 *
 * It never runs the package test sweep; CI's test shards do. So a preopen proof
 * is recorded apart from the full one, and the arming check never reads it.
 */

/** One preopen step: a name for the log, and the arguments `pnpm` gets. */
export interface PreopenStep {
  /** What the step is, as the log names it. */
  name: 'test:scripts' | 'scripts-repo' | 'lint:changed' | 'lint:root' | 'typecheck-lint';
  /** Arguments to `pnpm`, run from the repository root. */
  args: readonly string[];
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** The extensions `.claude/hooks/lint-changed.sh` lints; the same list, so the two agree. */
const LINTABLE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/**
 * Paths that reach the scripts suite beyond the scope script's own list: the
 * agent and CI configuration a scripts-suite test may pin, and the root
 * `package.json` that names every script.
 */
const ALSO_RUNS_SCRIPTS = /^(\.agents\/|\.claude\/|\.github\/|package\.json$)/;

/**
 * Paths that change what `eslint .` from the root does to files nobody touched: the
 * root config, the shared config package, and the dependencies both resolve.
 */
const RELINTS_ROOT =
  /^(eslint\.config\.js$|packages\/eslint-config\/|package\.json$|pnpm-lock\.yaml$)/;

/** Past this many changed files the list stops being cheaper than `eslint .` itself. */
export const MAX_LINT_FILES = 200;

/**
 * Where the change starts: the merge base with `origin/main`, or with `main`
 * in a clone that has no `origin`.
 *
 * @param cwd - A directory inside the checkout.
 * @returns The merge-base commit.
 * @throws When neither `origin/main` nor `main` shares history with HEAD.
 */
export function preopenBase(cwd: string): string {
  for (const ref of ['origin/main', 'main']) {
    try {
      return git(cwd, 'merge-base', ref, 'HEAD').trim();
    } catch {
      // No such ref, or no shared history: try the next one.
    }
  }
  throw new Error('pnpm verify:preopen found no merge base with origin/main or main');
}

/**
 * Every path the change touches, from the merge base to the working tree: committed,
 * staged, unstaged, deleted and untracked alike, repository-relative.
 *
 * @param cwd - The repository root.
 * @param base - The commit the change starts from.
 * @returns The paths, each once, sorted.
 */
export function changedPaths(cwd: string, base: string): string[] {
  const split = (out: string) => out.split('\0').filter((entry) => entry !== '');
  const tracked = split(git(cwd, 'diff', '--no-renames', '--name-only', '-z', base, '--'));
  const untracked = split(git(cwd, 'ls-files', '--others', '--exclude-standard', '-z'));
  return [...new Set([...tracked, ...untracked])].sort();
}

/**
 * Whether the change can reach the scripts suite. The scope script decides, from its
 * one copy of the list, and the extra paths above widen it.
 *
 * @param root - The repository holding `scripts/scripts-test-scope.sh`.
 * @param changed - Repository-relative changed paths.
 * @returns `true` when `pnpm test:scripts` must run. A scope script that fails also
 *   answers `true`, so a broken check runs more, never less.
 */
export function needsScriptsSuite(root: string, changed: readonly string[]): boolean {
  if (changed.some((file) => ALSO_RUNS_SCRIPTS.test(file))) return true;
  const result = spawnSync('bash', [path.join(root, 'scripts/scripts-test-scope.sh')], {
    input: changed.join('\n'),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const verdict = result.stdout?.trim();
  if (result.status === 0 && verdict === 'false') return false;
  if (result.status !== 0 || verdict !== 'true') {
    console.warn('pnpm verify:preopen could not read the scripts scope, so it runs test:scripts');
  }
  return true;
}

/**
 * The changed files ESLint should see, by the rules `.claude/hooks/lint-changed.sh`
 * uses: a JS or TS extension, a file that still exists, and a real path inside the
 * repository (a symlink out of it is not ours to lint).
 *
 * @param cwd - The repository root.
 * @param changed - Repository-relative changed paths.
 * @returns Absolute paths, in the order given.
 */
export function lintableFiles(cwd: string, changed: readonly string[]): string[] {
  const top = realpathSync(cwd);
  return changed
    .filter((file) => LINTABLE.test(file))
    .map((file) => path.join(top, file))
    .filter((file) => {
      try {
        return statSync(file).isFile() && realpathSync(file).startsWith(top + path.sep);
      } catch {
        return false; // deleted, or a dangling link
      }
    });
}

/**
 * The steps a preopen run takes for the checkout's current change.
 *
 * @param cwd - The checkout to verify.
 * @param root - The repository the scope script is read from: this script's own, so
 *   the scope matches the checks it ships with.
 * @returns The steps in run order; the typecheck and lint step is always last.
 */
export function planPreopen(cwd: string, root: string): PreopenStep[] {
  const top = git(cwd, 'rev-parse', '--show-toplevel').trim();
  const changed = changedPaths(top, preopenBase(top));
  const steps: PreopenStep[] = [
    needsScriptsSuite(root, changed)
      ? { name: 'test:scripts', args: ['run', 'test:scripts'] }
      : {
          name: 'scripts-repo',
          args: ['exec', 'vitest', 'run', '--config', 'scripts/vitest.repo.config.ts'],
        },
  ];
  const files = lintableFiles(top, changed);
  if (changed.some((file) => RELINTS_ROOT.test(file)) || files.length > MAX_LINT_FILES) {
    steps.push({ name: 'lint:root', args: ['run', 'lint:root'] });
  } else if (files.length > 0) {
    steps.push({ name: 'lint:changed', args: ['exec', 'eslint', '--no-warn-ignored', ...files] });
  }
  steps.push({ name: 'typecheck-lint', args: ['run', 'verify:preopen:turbo'] });
  return steps;
}

/**
 * Run the steps in order, stopping at the first that fails.
 *
 * @param steps - The plan from {@link planPreopen}.
 * @param exec - Runs one step and returns its exit code.
 * @returns 0 when every step passed, otherwise the failing step's exit code.
 */
export function runPreopen(
  steps: readonly PreopenStep[],
  exec: (step: PreopenStep) => number
): number {
  for (const step of steps) {
    const status = exec(step);
    if (status !== 0) return status;
  }
  return 0;
}
