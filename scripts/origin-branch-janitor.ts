/**
 * The origin pass of scripts/worktree-janitor.sh: branches on origin that no
 * pull request is using any more.
 *
 * WHY. GitHub deletes a PR's head branch when the PR merges, so merged work
 * cleans itself up. A branch that never became a PR does not: a Codex attempt
 * that lost to a sibling, a `codex/archive/*` pinned-SHA twin, a review branch
 * nobody opened. Each also keeps a Neon preview database alive (see
 * scripts/neon-preview-sweep.ts). research/20260801_worktree-and-branch-sweep.md
 * found 402 of them the first time.
 *
 * WHAT IT DOES. Every origin branch with no open PR and no worktree in this
 * clone gets one verdict:
 *   SAFE    in-main      its tip is already in the default branch, so deleting it loses nothing
 *   SAFE    merged-pr    a merged PR had this head ref at exactly this tip
 *   REPORT  <reason>     anything else; printed for a person, never deleted
 * Skipped outright, whatever else is true: the default branch, ci-steward-data,
 * release branches, merge-queue branches, any branch with an open PR or that an
 * open PR targets as its base, any branch checked out in a worktree here, and any
 * branch whose tip COMMIT is younger than DORKOS_JANITOR_IDLE_HOURS (default 24).
 * That is commit age, not push age, which git cannot see: a branch pushed a minute
 * ago from an old tip of main counts as idle. It is still only SAFE when its tip is
 * already in main, so the worst case is a deleted pointer to shipped commits.
 *
 * Report is the default; `--fix` deletes the SAFE ones and nothing else, each with
 * `--force-with-lease` on the tip it judged, so a branch pushed to in between is
 * left alone. Every deletion is logged with its SHA to the janitor's recovery log;
 * restore one with `git push origin <sha>:refs/heads/<name>`.
 *
 * Every unknown refuses: a failed fetch, an unreadable branch list, or a PR list
 * that failed or may be truncated stops the run before it judges anything. An
 * ancestry check that errors is REPORT, never SAFE.
 *
 * Usage: scripts/worktree-janitor.sh --origin [--fix | --json]
 * Pinned by scripts/__tests__/origin-branch-janitor.test.ts.
 *
 * @module origin-branch-janitor
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One pull request, as `gh pr list --json number,headRefName,headRefOid,baseRefName,state` returns it. */
export interface PrRecord {
  number: number;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
}

/** What is known about one origin branch. `null` means it could not be measured. */
export interface BranchFacts {
  name: string;
  sha: string;
  defaultBranch: string;
  /** Every PR whose head is this branch. */
  prs: PrRecord[];
  /** An open PR targets this branch; deleting it would close that PR. */
  isBaseOfOpenPr: boolean;
  hasWorktree: boolean;
  ancestorOfDefault: boolean | null;
  tipAgeHours: number | null;
  idleHours: number;
}

/** A branch's verdict: skipped (not a candidate), reported, or safe to delete. */
export interface Verdict {
  kind: 'skip' | 'report' | 'safe';
  reason: string;
}

const DATA_BRANCH = 'ci-steward-data';

/** Branch names this pass never touches, whatever the facts say. */
export function isProtectedName(name: string, defaultBranch: string): boolean {
  return (
    name === defaultBranch ||
    name === DATA_BRANCH ||
    name.startsWith(`${DATA_BRANCH}/`) ||
    /^releases?([/-]|$)/.test(name) ||
    name.startsWith('gh-readonly-queue/')
  );
}

/**
 * Judge one origin branch. Pure: every fact is passed in.
 *
 * @param f - the facts about one branch
 * @returns skip, report, or safe, with the reason
 */
export function classify(f: BranchFacts): Verdict {
  if (isProtectedName(f.name, f.defaultBranch)) return { kind: 'skip', reason: 'protected' };
  if (f.prs.some((p) => p.state === 'OPEN')) return { kind: 'skip', reason: 'pr-open' };
  if (f.isBaseOfOpenPr) return { kind: 'skip', reason: 'base-of-open-pr' };
  if (f.hasWorktree) return { kind: 'skip', reason: 'has-worktree' };
  if (f.tipAgeHours === null) return { kind: 'report', reason: 'tip-age-unknown' };
  if (f.tipAgeHours < f.idleHours) return { kind: 'skip', reason: 'recent' };
  if (f.ancestorOfDefault === true) return { kind: 'safe', reason: 'in-main' };
  if (f.prs.some((p) => p.state === 'MERGED' && p.headRefOid === f.sha)) {
    return { kind: 'safe', reason: 'merged-pr' };
  }
  if (f.ancestorOfDefault === null) return { kind: 'report', reason: 'ancestry-unknown' };
  if (f.prs.some((p) => p.state === 'MERGED')) {
    return { kind: 'report', reason: 'commits-after-merge' };
  }
  if (f.prs.some((p) => p.state === 'CLOSED')) return { kind: 'report', reason: 'closed-pr' };
  return { kind: 'report', reason: 'no-pr' };
}

/** Runs a command and returns its exit status and stdout; injectable for tests. */
export type Exec = (cmd: string, args: string[]) => { status: number | null; stdout: string };

const realExec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 120_000 });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '' };
};

const PR_LIMIT = 5000;

/** Thrown when an input the whole run depends on could not be read. */
class Refusal extends Error {}

function readPrs(exec: Exec): { byHead: Map<string, PrRecord[]>; openBases: Set<string> } {
  const r = exec('gh', [
    'pr',
    'list',
    '--state',
    'all',
    '--limit',
    String(PR_LIMIT),
    '--json',
    'number,headRefName,headRefOid,baseRefName,state',
  ]);
  let prs: unknown;
  try {
    prs = r.status === 0 ? JSON.parse(r.stdout) : null;
  } catch {
    prs = null;
  }
  if (!Array.isArray(prs)) throw new Refusal('could not read pull requests from GitHub');
  if (prs.length >= PR_LIMIT)
    throw new Refusal(`pull request list hit ${PR_LIMIT}; may be truncated`);
  const byHead = new Map<string, PrRecord[]>();
  const openBases = new Set<string>();
  for (const p of prs as PrRecord[]) {
    byHead.set(p.headRefName, [...(byHead.get(p.headRefName) ?? []), p]);
    if (p.state === 'OPEN') openBases.add(p.baseRefName);
  }
  return { byHead, openBases };
}

function readOriginHeads(exec: Exec): { name: string; sha: string }[] {
  const r = exec('git', ['ls-remote', '--heads', 'origin']);
  const heads = r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
  if (heads.length === 0) throw new Refusal('could not list branches on origin');
  return heads.map((line) => {
    const [sha = '', ref = ''] = line.split('\t');
    return { sha, name: ref.replace(/^refs\/heads\//, '') };
  });
}

function readWorktreeBranches(exec: Exec): Set<string> {
  const r = exec('git', ['worktree', 'list', '--porcelain']);
  if (r.status !== 0) throw new Refusal('could not list worktrees');
  return new Set(
    r.stdout
      .split('\n')
      .filter((l) => l.startsWith('branch refs/heads/'))
      .map((l) => l.slice('branch refs/heads/'.length))
  );
}

function ancestry(exec: Exec, sha: string, base: string): boolean | null {
  const s = exec('git', ['merge-base', '--is-ancestor', sha, base]).status;
  if (s === 0) return true;
  if (s === 1) return false;
  return null;
}

function tipAgeHours(exec: Exec, sha: string, nowMs: number): number | null {
  const r = exec('git', ['log', '-1', '--format=%ct', sha]);
  const t = Number(r.stdout.trim());
  if (r.status !== 0 || !Number.isFinite(t) || t <= 0) return null;
  return (nowMs - t * 1000) / 3_600_000;
}

/** One judged branch, as the plan and `--json` carry it. */
export interface PlanEntry extends Verdict {
  name: string;
  sha: string;
  prs: number[];
}

/**
 * Read origin, the PRs and this clone's worktrees, and judge every origin branch.
 *
 * @param exec - how to run git and gh
 * @param opts - the clock and the idle threshold
 * @returns one entry per origin branch, sorted by name
 */
export function buildPlan(exec: Exec, opts: { nowMs: number; idleHours: number }): PlanEntry[] {
  if (exec('git', ['fetch', '--prune', '--quiet', 'origin']).status !== 0) {
    throw new Refusal('git fetch failed; refusing to judge stale refs');
  }
  const head = exec('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const defaultBranch =
    head.status === 0 ? head.stdout.trim().replace(/^origin\//, '') || 'main' : 'main';
  // Pinned once: every ancestry answer in this run is against the same commit.
  const base = exec('git', ['rev-parse', '--verify', `refs/remotes/origin/${defaultBranch}`]);
  if (base.status !== 0) throw new Refusal(`could not resolve origin/${defaultBranch}`);
  const baseSha = base.stdout.trim();

  const { byHead, openBases } = readPrs(exec);
  const worktrees = readWorktreeBranches(exec);
  return readOriginHeads(exec)
    .map(({ name, sha }) => {
      const forHead = byHead.get(name) ?? [];
      const verdict = classify({
        name,
        sha,
        defaultBranch,
        prs: forHead,
        isBaseOfOpenPr: openBases.has(name),
        hasWorktree: worktrees.has(name),
        ancestorOfDefault: ancestry(exec, sha, baseSha),
        tipAgeHours: tipAgeHours(exec, sha, opts.nowMs),
        idleHours: opts.idleHours,
      });
      return { name, sha, prs: forHead.map((p) => p.number), ...verdict };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Delete one SAFE branch, only if origin still has it at the judged tip. */
function deleteBranch(exec: Exec, e: PlanEntry): boolean {
  const lease = `--force-with-lease=refs/heads/${e.name}:${e.sha}`;
  return exec('git', ['push', '--quiet', lease, 'origin', `:refs/heads/${e.name}`]).status === 0;
}

function printPlan(plan: PlanEntry[], fix: boolean, log: (l: string) => void) {
  const safe = plan.filter((e) => e.kind === 'safe');
  const report = plan.filter((e) => e.kind === 'report');
  const skipped = plan.length - safe.length - report.length;
  const tail = fix ? '' : ' (dry run — pass --fix to delete the SAFE ones)';
  log(`origin pass: ${safe.length} safe, ${report.length} to look at, ${skipped} skipped${tail}`);
  log('');
  for (const e of report) log(`  REPORT  ${e.name.padEnd(56)} ${e.reason}`);
  if (!fix) for (const e of safe) log(`  SAFE    ${e.name.padEnd(56)} ${e.reason}`);
}

/** Options for one run of the origin pass. */
export interface MainOptions {
  argv: string[];
  exec?: Exec;
  log?: (line: string) => void;
  nowMs?: number;
  env?: Record<string, string | undefined>;
}

/**
 * Run the origin pass.
 *
 * @param opts - arguments, and the injectable process, log, clock and environment
 * @returns the exit code: 0 ok, 1 a deletion failed, 2 refused or bad arguments
 */
export function main(opts: MainOptions): number {
  const { argv, exec = realExec, log = console.log, nowMs = Date.now(), env = process.env } = opts;
  const fix = argv.includes('--fix');
  const json = argv.includes('--json');
  const unknown = argv.filter((a) => a !== '--fix' && a !== '--json');
  if (unknown.length || (fix && json)) {
    log(unknown.length ? `unknown argument: ${unknown[0]}` : 'conflicting modes: --fix and --json');
    return 2;
  }
  // An empty, zero or negative value would switch the "recent" guard off; keep the default.
  const raw = Number(env.DORKOS_JANITOR_IDLE_HOURS);
  const idleHours = Number.isFinite(raw) && raw >= 1 ? raw : 24;
  let plan: PlanEntry[];
  try {
    plan = buildPlan(exec, { nowMs, idleHours });
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    log(`origin pass refused: ${err.message}`);
    return 2;
  }
  if (json) {
    log(JSON.stringify({ entries: plan }, null, 2));
    return 0;
  }
  printPlan(plan, fix, log);
  if (!fix) return 0;

  const reapLog = join(env.DORK_HOME ?? join(env.HOME ?? '.', '.dork'), 'worktree-janitor.log');
  let failed = 0;
  for (const e of plan.filter((x) => x.kind === 'safe')) {
    if (deleteBranch(exec, e)) {
      log(`  deleted ${e.name.padEnd(56)} ${e.sha}`);
      try {
        mkdirSync(dirname(reapLog), { recursive: true });
        const line = [new Date(nowMs).toISOString(), 'origin-deleted', e.sha, e.name, e.reason];
        appendFileSync(reapLog, `${line.join('\t')}\n`);
      } catch {
        // The deletion already happened; a missing log line must not report it as failed.
      }
    } else {
      failed++;
      log(`  FAILED  ${e.name}`);
    }
  }
  log('');
  log(`origin pass: restore any deleted branch with git push origin <sha>:refs/heads/<name>`);
  return failed > 0 ? 1 : 0;
}

/** True when node was started on this file; resolves symlinks so a linked checkout still runs. */
function isEntryPoint(): boolean {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exit(main({ argv: process.argv.slice(2) }));
}
