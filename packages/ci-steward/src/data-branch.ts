/**
 * The `ci-steward-data` branch: getting a working tree of it, publishing to
 * it, and tagging it weekly (plan §4.4, data-branch safeguards).
 *
 * The branch is the only copy of the pipeline's history, so:
 *
 * - it is created exactly once, by the first collector run, and only when
 *   neither the branch nor any backup tag exists. If the branch is gone but a
 *   tag exists, the history was lost after it started, and recreating an empty
 *   branch would bury that: `prepareDataDir` refuses, and names the restore
 *   command instead;
 * - it is an orphan branch holding data files only, never repo code;
 * - every writer fetches, rebases and retries on a rejected push (follow-up O).
 *   Two writers never write the same file (the collector owns everything but
 *   `local/<clone>/`, each clone owns its own folder), so a rebase never
 *   conflicts;
 * - each Monday the collector tags the head `<prefix>YYYY-Www`; ruleset
 *   23705388 makes those tags permanent.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';

/** Runs git with arguments in a directory; returns stdout, throws on a non-zero exit. */
export type Git = (cwd: string, args: readonly string[]) => string;

/** The real git. */
export const realGit: Git = (cwd, args) =>
  execFileSync('git', [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * Git that authenticates to github.com with a token for this process only.
 *
 * The workflow checks out with `persist-credentials: false`, so no token sits
 * in `.git/config` while `pnpm install` runs dependency scripts; only the
 * publish step is given one. It travels as an HTTP header in `GIT_CONFIG_*`
 * environment variables, never on the command line, where the process list
 * would show it.
 *
 * @param token - A token with `contents: write` (the job's GITHUB_TOKEN).
 */
export function tokenGit(token: string): Git {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  const env = {
    // eslint-disable-next-line no-restricted-syntax -- git needs the rest of the environment (PATH, HOME)
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
  return (cwd, args) =>
    execFileSync('git', [...args], {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
}

/** Where the branch and its tags live. */
export interface DataBranchRef {
  /** A checkout of the repository (the working tree the command runs in). */
  repo: string;
  remote: string;
  branch: string;
  /** e.g. `ci-steward-data/`. */
  tagPrefix: string;
}

/** The branch is gone but backups exist: never recreate, restore. */
export class DataBranchMissing extends Error {
  readonly restoreCommand: string;
  constructor(ref: DataBranchRef, newestTag: string) {
    const cmd = `git fetch ${ref.remote} tag ${newestTag} && git push ${ref.remote} '${newestTag}^{commit}:refs/heads/${ref.branch}'`;
    super(
      `The ${ref.branch} branch is missing from ${ref.remote}, but backup tags exist (newest: ${newestTag}). The collector will not recreate it, because an empty branch would bury the history. Restore it from the newest backup, then re-run the workflow:\n\n  ${cmd}\n`
    );
    this.name = 'DataBranchMissing';
    this.restoreCommand = cmd;
  }
}

/**
 * What the remote holds: the branch head, and every backup tag, oldest first.
 *
 * @param git - The git runner.
 * @param ref - The branch.
 */
export function remoteState(git: Git, ref: DataBranchRef): { head: string | null; tags: string[] } {
  const heads = git(ref.repo, [
    'ls-remote',
    '--heads',
    ref.remote,
    `refs/heads/${ref.branch}`,
  ]).trim();
  const tags = git(ref.repo, [
    'ls-remote',
    '--tags',
    '--refs',
    ref.remote,
    `refs/tags/${ref.tagPrefix}*`,
  ])
    .split('\n')
    .flatMap((l) => {
      const m = /\trefs\/tags\/(.+)$/.exec(l);
      return m ? [m[1]!] : [];
    })
    .sort();
  return { head: heads ? heads.split(/\s/)[0]! : null, tags };
}

/**
 * Produce a working tree of the data branch at `dir`: the remote branch when
 * it exists, a new orphan branch on the very first run, or an error naming the
 * restore command when the branch is gone but backups exist.
 *
 * @param git - The git runner.
 * @param ref - The branch.
 * @param dir - Where the working tree goes; must not exist yet.
 * @returns Whether this run created the branch.
 */
export function prepareDataDir(
  git: Git,
  ref: DataBranchRef,
  dir: string
): { bootstrapped: boolean } {
  const state = remoteState(git, ref);
  if (state.head) {
    git(ref.repo, [
      'fetch',
      '--quiet',
      ref.remote,
      `+refs/heads/${ref.branch}:refs/remotes/${ref.remote}/${ref.branch}`,
    ]);
    git(ref.repo, [
      'worktree',
      'add',
      '--quiet',
      '--detach',
      dir,
      `refs/remotes/${ref.remote}/${ref.branch}`,
    ]);
    return { bootstrapped: false };
  }
  if (state.tags.length > 0) throw new DataBranchMissing(ref, state.tags.at(-1)!);
  git(ref.repo, ['worktree', 'add', '--quiet', '--detach', dir]);
  git(dir, ['checkout', '--quiet', '--orphan', ref.branch]);
  git(dir, ['rm', '-r', '-q', '-f', '--ignore-unmatch', '.']);
  git(dir, ['clean', '-f', '-d', '-x', '-q']);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'README.md'),
    [
      `# ${ref.branch}`,
      '',
      'Machine-owned observations of the CI pipeline, written by the CI Steward collector',
      '(`.github/workflows/ci-steward.yml`) and by `ci-steward local-export`. Append-only: ruleset',
      '23704437 forbids deletion and force-push, and weekly backup tags are permanent.',
      '',
      'Read it with `pnpm ci:status`, or `git show origin/ci-steward-data:latest.json`. The file',
      'formats are defined in `packages/ci-steward/src/data.ts` on the default branch. Never edit by hand.',
      '',
    ].join('\n')
  );
  return { bootstrapped: true };
}

/** Sleep synchronously; the retry loop has nothing else to do meanwhile. */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Commit everything in the working tree and push it, fetching and rebasing
 * onto the remote and retrying when another writer got there first.
 *
 * @param git - The git runner.
 * @param ref - The branch.
 * @param dir - The working tree.
 * @param message - The commit message.
 * @param opts - Retry count and back-off (tests shorten it).
 * @returns `nothing` when there was nothing to commit, else the pushed SHA.
 */
export function publish(
  git: Git,
  ref: DataBranchRef,
  dir: string,
  message: string,
  opts: { attempts?: number; backoffMs?: number } = {}
): string {
  const attempts = opts.attempts ?? 4;
  git(dir, ['add', '-A']);
  if (git(dir, ['status', '--porcelain']).trim() === '') return 'nothing';
  git(dir, [
    '-c',
    'user.name=ci-steward',
    '-c',
    'user.email=ci-steward@users.noreply.github.com',
    'commit',
    '--quiet',
    '-m',
    message,
  ]);
  let lastError: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      git(dir, ['push', '--quiet', ref.remote, `HEAD:refs/heads/${ref.branch}`]);
      return git(dir, ['rev-parse', 'HEAD']).trim();
    } catch (e) {
      lastError = e;
      if (i === attempts) break;
      sleepMs((opts.backoffMs ?? 2000) * i);
      git(dir, [
        'fetch',
        '--quiet',
        ref.remote,
        `+refs/heads/${ref.branch}:refs/remotes/${ref.remote}/${ref.branch}`,
      ]);
      try {
        git(dir, [
          '-c',
          'user.name=ci-steward',
          '-c',
          'user.email=ci-steward@users.noreply.github.com',
          'rebase',
          '--quiet',
          `refs/remotes/${ref.remote}/${ref.branch}`,
        ]);
      } catch (re) {
        git(dir, ['rebase', '--abort']);
        throw new Error(
          `Rebasing onto ${ref.remote}/${ref.branch} conflicted, so two writers changed the same file. That should be impossible (each writer owns its own paths); nothing was pushed.`,
          { cause: re }
        );
      }
    }
  }
  throw new Error(`Pushing to ${ref.branch} failed ${attempts} times.`, { cause: lastError });
}

/**
 * Tag the pushed head as this week's permanent backup, unless the tag exists.
 * Every publish calls it, so a week whose Monday run failed is still tagged by
 * the next run that succeeds.
 *
 * @param git - The git runner.
 * @param ref - The branch.
 * @param dir - The working tree, at the pushed head.
 * @param week - The ISO week, e.g. `2026-W39`.
 * @returns The tag name, and whether this call created it.
 */
export function tagWeek(
  git: Git,
  ref: DataBranchRef,
  dir: string,
  week: string
): { tag: string; created: boolean } {
  const tag = `${ref.tagPrefix}${week}`;
  if (remoteState(git, ref).tags.includes(tag)) return { tag, created: false };
  git(dir, ['tag', tag, 'HEAD']);
  git(dir, ['push', '--quiet', ref.remote, `refs/tags/${tag}`]);
  return { tag, created: true };
}

/**
 * Remove the data working tree (and its worktree registration).
 *
 * @param git - The git runner.
 * @param ref - The branch.
 * @param dir - The working tree.
 */
export function removeDataDir(git: Git, ref: DataBranchRef, dir: string): void {
  if (existsSync(dir)) git(ref.repo, ['worktree', 'remove', '--force', dir]);
}
