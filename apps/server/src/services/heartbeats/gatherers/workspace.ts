/**
 * The `workspace` gatherer (spec `heartbeats` §5): local git only.
 *
 * - New commits on the default branch since the last beat by someone other
 *   than this checkout's configured author, read with `git log`. Never
 *   `fetch`: a beat reads what is on disk, it does not reach the network.
 * - A failing check on the agent's own branch, read with `gh pr checks` at most
 *   once per 30 minutes per checkout, cached between beats.
 *
 * An agent with no working directory skips it, and so does one whose working
 * directory is an agent folder: DorkOS never runs git or `gh` there (DOR-3343).
 * Off unless `HEARTBEAT.md`'s `watch:` names it.
 *
 * @module services/heartbeats/gatherers/workspace
 */
import { execFile } from 'node:child_process';
import { mayRunGitHere } from '../../core/agent-identity/index.js';
import type { Change, GatherContext, Gatherer } from './types.js';

/** How often `gh pr checks` may run per checkout. */
export const PR_CHECKS_TTL_MS = 30 * 60 * 1000;

/** Runs a command, resolving its stdout, or rejecting. */
export type RunCommand = (
  command: string,
  args: string[],
  options: { cwd: string; signal: AbortSignal }
) => Promise<string>;

/** The real command runner, bounded to two seconds. */
export const runCommand: RunCommand = (command, args, { cwd, signal }) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { cwd, signal, timeout: 2000, maxBuffer: 256 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    );
  });

/** One cached `gh pr checks` answer. */
interface CachedChecks {
  at: number;
  failing: string[];
}

/** The default branch's name: `origin/HEAD` when known, else main or master. */
async function defaultBranch(run: RunCommand, cwd: string, signal: AbortSignal): Promise<string> {
  try {
    const ref = (
      await run('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
        cwd,
        signal,
      })
    ).trim();
    if (ref) return ref.replace(/^origin\//, '');
  } catch {
    // No origin/HEAD: fall through to the usual names.
  }
  try {
    await run('git', ['rev-parse', '--verify', '--quiet', 'main'], { cwd, signal });
    return 'main';
  } catch {
    return 'master';
  }
}

/**
 * The failing checks on the current branch's pull request, or null when `gh`
 * could not answer (no PR, no `gh`, a timeout or an abort).
 *
 * @param run - How commands run.
 * @param cwd - The checkout.
 * @param signal - The gatherer's deadline.
 */
async function readFailingChecks(
  run: RunCommand,
  cwd: string,
  signal: AbortSignal
): Promise<string[] | null> {
  try {
    const output = await run('gh', ['pr', 'checks', '--json', 'name,bucket'], { cwd, signal });
    if (signal.aborted) return null;
    const parsed = JSON.parse(output) as Array<{ name?: string; bucket?: string }>;
    return parsed
      .filter((check) => check.bucket === 'fail')
      .map((check) => check.name ?? 'a check');
  } catch {
    return null;
  }
}

/**
 * Build the gatherer.
 *
 * @param run - How commands run; tests pass a fake.
 * @param now - The clock, for the checks cache.
 */
export function createWorkspaceGatherer(
  run: RunCommand = runCommand,
  now: () => number = Date.now
): Gatherer {
  const checks = new Map<string, CachedChecks>();
  return async (ctx: GatherContext): Promise<Change[]> => {
    const cwd = ctx.agent.cwd;
    if (!cwd || !mayRunGitHere(cwd)) return [];
    const signal = ctx.signal;
    try {
      await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd, signal });
    } catch {
      return [];
    }
    const changes: Change[] = [];
    const base = await defaultBranch(run, cwd, signal);
    const me = (await run('git', ['config', 'user.email'], { cwd, signal }).catch(() => '')).trim();
    if (ctx.since) {
      const log = await run(
        'git',
        ['log', base, `--since=${ctx.since}`, '--format=%H%x09%ae%x09%cI', '-n', '20'],
        { cwd, signal }
      ).catch(() => '');
      for (const line of log.split('\n')) {
        const [sha, email, at] = line.split('\t');
        if (!sha || !at || email === me) continue;
        changes.push({
          gatherer: 'workspace',
          key: `commit:${sha}`,
          // Never the subject: someone else's words are not the beat's to quote.
          summary: `New commit on ${base} by ${email}.`,
          at,
          ref: { kind: 'commit', id: sha },
          signal: 'commits',
        });
      }
    }

    const branch = (
      await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, signal }).catch(() => '')
    ).trim();
    if (branch && branch !== base && branch !== 'HEAD') {
      const cacheKey = `${cwd}\u0000${branch}`;
      let cached = checks.get(cacheKey);
      if (!cached || now() - cached.at >= PR_CHECKS_TTL_MS) {
        const fresh = await readFailingChecks(run, cwd, signal);
        // A failed or timed-out read is not an answer: nothing is cached, and
        // the next beat asks again.
        if (fresh !== null) {
          cached = { at: now(), failing: fresh };
          checks.set(cacheKey, cached);
        }
      }
      if (!cached) return changes;
      for (const name of cached.failing) {
        changes.push({
          gatherer: 'workspace',
          key: `check:${branch}:${name}`,
          summary: `The "${name}" check is failing on your branch ${branch}.`,
          at: new Date(cached.at).toISOString(),
          signal: 'check-failed',
        });
      }
    }
    return changes;
  };
}
