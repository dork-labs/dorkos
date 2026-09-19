/**
 * The run-level series of one day, computed from its workflow runs alone:
 * pr-feedback, queue builds and their outcome, commits on the default branch,
 * and the automated review's completions and recoveries.
 */
import type { Run } from './collect.ts';
import type { MainCommit, QueueBuild, Snapshot, TimedSample } from './data.ts';
import { minutesBetween, round, secondOfDay } from './time.ts';

/** Conclusions that count as a failure. */
export const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);
const QUEUE_REF = /^gh-readonly-queue\/[^/]+\/pr-(\d+)-/;

function groupBy<T>(xs: readonly T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = m.get(k);
    if (list) list.push(x);
    else m.set(k, [x]);
  }
  return m;
}

/** The earliest run of each workflow among a SHA's runs. */
function earliestPerWorkflow(runs: readonly Run[]): Map<string, Run> {
  const m = new Map<string, Run>();
  for (const r of runs) {
    const cur = m.get(r.path);
    if (!cur || r.created_at < cur.created_at) m.set(r.path, r);
  }
  return m;
}

/**
 * The required workflows that actually ran on an event that day. The required
 * set changes over time, so a backfilled day is judged by what was required
 * and running then, not by today's list.
 */
function requiredSeen(runs: readonly Run[], required: readonly string[], event: string): string[] {
  const seen = new Set(runs.filter((r) => r.event === event).map((r) => r.path));
  return required.filter((p) => seen.has(p));
}

/**
 * pr-feedback samples: per PR head SHA that ran every required workflow the
 * day's pull requests ran, and whose first run of each went green on its first
 * attempt, the minutes from the first required run created to the last one
 * finished.
 */
export function prFeedback(runs: readonly Run[], requiredAll: readonly string[]): TimedSample[] {
  const out: TimedSample[] = [];
  const required = requiredSeen(runs, requiredAll, 'pull_request');
  const pr = runs.filter((r) => r.event === 'pull_request' && required.includes(r.path));
  for (const shaRuns of groupBy(pr, (r) => r.head_sha).values()) {
    const first = earliestPerWorkflow(shaRuns);
    if (required.length === 0 || first.size !== required.length) continue;
    const rs = [...first.values()];
    if (
      rs.some((r) => r.status !== 'completed' || r.conclusion !== 'success' || r.run_attempt !== 1)
    )
      continue;
    const start = rs.map((r) => r.created_at).sort()[0]!;
    const end = rs
      .map((r) => r.updated_at)
      .sort()
      .at(-1)!;
    out.push([secondOfDay(start), round(minutesBetween(start, end), 1)]);
  }
  return out;
}

/** Queue builds: one per `gh-readonly-queue/*` head SHA, judged over the required workflows. */
export function queueBuilds(
  runs: readonly Run[],
  required: readonly string[],
  failedGates: ReadonlyMap<string, string[]>
): QueueBuild[] {
  const mg = runs.filter((r) => r.event === 'merge_group');
  const out: QueueBuild[] = [];
  for (const [sha, rs] of groupBy(mg, (r) => r.head_sha)) {
    const req = rs.filter((r) => required.includes(r.path));
    if (req.length === 0) continue;
    const latest = new Map<string, Run>();
    for (const r of req) {
      const cur = latest.get(r.path);
      if (!cur || r.run_attempt > cur.run_attempt || r.created_at > cur.created_at)
        latest.set(r.path, r);
    }
    const ls = [...latest.values()];
    let outcome: QueueBuild['outcome'];
    // Judged over the required workflows that ran for this build: the required
    // set has changed over time, and a backfilled day predates today's.
    if (ls.some((r) => r.status === 'completed' && FAILED.has(r.conclusion ?? ''))) outcome = 'red';
    else if (ls.some((r) => r.conclusion === 'cancelled')) outcome = 'cancelled';
    else if (ls.every((r) => r.status === 'completed' && r.conclusion === 'success'))
      outcome = 'green';
    else outcome = 'pending';
    const m = QUEUE_REF.exec(rs[0]!.head_branch ?? '');
    out.push({
      sha: sha.slice(0, 12),
      pr: m ? Number(m[1]) : null,
      created_at: rs.map((r) => r.created_at).sort()[0]!,
      outcome,
      failed_gates: failedGates.get(sha) ?? [],
    });
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** Commits on the default branch and whether their push checks went red. */
export function mainCommits(runs: readonly Run[], defaultBranch: string): MainCommit[] {
  const push = runs.filter((r) => r.event === 'push' && r.head_branch === defaultBranch);
  const out: MainCommit[] = [];
  for (const [sha, rs] of groupBy(push, (r) => r.head_sha)) {
    if (rs.some((r) => r.status !== 'completed')) continue;
    out.push({
      sha: sha.slice(0, 12),
      at: rs.map((r) => r.created_at).sort()[0]!,
      done: rs
        .map((r) => r.updated_at)
        .sort()
        .at(-1)!,
      red: rs.some((r) => FAILED.has(r.conclusion ?? '')),
    });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** review-completes and review-recovery, from the review workflow's runs keyed by head SHA. */
export function reviews(runs: readonly Run[], reviewWorkflow: string, snap: Snapshot): void {
  const rv = runs.filter(
    (r) =>
      r.path.endsWith(`/${reviewWorkflow}`) &&
      r.conclusion !== 'skipped' &&
      r.event.startsWith('pull_request')
  );
  snap.counts.review_runs = rv.length;
  for (const rs of groupBy(rv, (r) => r.head_sha).values()) {
    const sorted = [...rs].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const first = sorted[0]!;
    if (first.status !== 'completed') continue;
    // A first review cancelled before it finished was superseded by a newer
    // push (or lost to the label race); the runs cannot tell which, and neither
    // is the review failing. Counted apart, outside the population.
    if (first.conclusion === 'cancelled') {
      snap.counts.review_cancelled += 1;
      continue;
    }
    snap.counts.review_shas += 1;
    if (first.conclusion === 'success') {
      snap.counts.review_first_ok += 1;
      continue;
    }
    const recovered = sorted.find((r) => r.conclusion === 'success');
    if (recovered) {
      snap.series.review_recovery_min.push([
        secondOfDay(first.updated_at),
        round(minutesBetween(first.updated_at, recovered.updated_at), 1),
      ]);
    }
  }
}
