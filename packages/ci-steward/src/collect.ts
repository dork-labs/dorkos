/**
 * `ci-steward collect`: one UTC day of pipeline observations into
 * `snapshots/YYYY-MM-DD.json` on the data branch (plan §4.4).
 *
 * For each day it reads, all through `gh`:
 *
 * - every Actions run created that day, in created-time windows small enough
 *   to stay under the API's 1,000-result cap, each asserted against its
 *   `total_count` (a shortfall is a health failure: truncated data never
 *   passes as a quiet day);
 * - the jobs of every head SHA, one `commits/{sha}/check-runs` call each,
 *   until the request budget is spent. A day that runs out is written as late
 *   and the next run resumes it where it stopped: late, never truncated;
 * - the timelines of every PR merged that day (queue entries and removals with
 *   their reasons, new commits, ready-for-review);
 * - a sample of queue builds' test reports, for flaky-test-runs.
 *
 * Once per run it also reads the releases, the Actions cache, and the three
 * rulesets: the merge-queue ruleset is reconciled against
 * `ci/required-checks.json`, and the two data-branch safeguards must still
 * exist, be active and be unchanged.
 */
import { mkdirSync } from 'node:fs';
import {
  emptySnapshot,
  gateKey,
  latestDay,
  localExportDays,
  readData,
  snapshotDays,
  snapshotPath,
  SnapshotSchema,
  writeData,
  type GateDay,
  type Health,
  type QueueBuild,
  type Snapshot,
} from './data.ts';
import { gateMapper, gateTimeouts, requiredWorkflowPaths, type GateMapper } from './gatemap.ts';
import { sampleFlaky } from './artifacts.ts';
import { BudgetExhausted, type Gh } from './gh.ts';
import type { HandFiles } from './load.ts';
import { fetchMergedPrs, type PrFacts } from './prs.ts';
import { canaryRuns, FAILED, mainCommits, prFeedback, queueBuilds, reviews } from './series.ts';
import { globalChecks, type GlobalChecks } from './rulesets.ts';
import { addDays, dayOf, dayRange, daysBetween, round, secondOfDay } from './time.ts';
import type { WorkflowModel } from './workflows.ts';

/** One workflow run, trimmed to what the collector reads. */
export interface Run {
  id: number;
  path: string;
  event: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  run_attempt: number;
  head_branch: string | null;
  head_sha: string;
}

/** Everything a collect run needs. */
export interface CollectOptions {
  gh: Gh;
  files: HandFiles;
  workflows: readonly WorkflowModel[];
  /** A working tree of the data branch (or a temp directory for a pulse). */
  dataDir: string;
  now: Date;
  /** Collect exactly these days instead of the planned ones. */
  days?: readonly string[];
  /** Also collect today so far, as a partial day that is never published (`ci:pulse`). */
  includeToday?: boolean;
  /** Scratch space for artifact downloads. */
  tmpDir: string;
}

/** What a collect run did. */
export interface CollectResult {
  /** Days planned for this run. */
  planned: string[];
  /** Days written, oldest first. */
  days: string[];
  /** What latest.json points at: the newest complete day on disk (see `latestDay`). */
  newest: string | null;
  healthy: boolean;
  failures: string[];
  apiCalls: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Runs, in windows under the 1,000-result cap

interface RunsFetch {
  runs: Run[];
  windows: Health['runs']['windows'];
  failures: string[];
}

function trimRun(r: Obj): Run {
  return {
    id: Number(r.id),
    path: String(r.path ?? ''),
    event: String(r.event ?? ''),
    status: String(r.status ?? ''),
    conclusion: typeof r.conclusion === 'string' ? r.conclusion : null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    run_attempt: Number(r.run_attempt ?? 1),
    head_branch: typeof r.head_branch === 'string' ? r.head_branch : null,
    head_sha: String(r.head_sha),
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

/**
 * Fetch every run created in `[fromMs, toMs]`, splitting the window in half
 * while GitHub reports more than 1,000 results for it.
 */
function fetchRunsWindow(gh: Gh, repo: string, fromMs: number, toMs: number, out: RunsFetch): void {
  const created = `${iso(fromMs)}..${iso(toMs)}`;
  const base = `repos/${repo}/actions/runs?created=${created}&per_page=100`;
  const first = gh.rest(`${base}&page=1`) as { total_count: number; workflow_runs: Obj[] };
  const total = first.total_count;
  if (total > 1000 && toMs - fromMs > 60_000) {
    const mid = fromMs + Math.floor((toMs - fromMs) / 2 / 1000) * 1000;
    fetchRunsWindow(gh, repo, fromMs, mid, out);
    fetchRunsWindow(gh, repo, mid + 1000, toMs, out);
    return;
  }
  const seen = new Map<number, Run>();
  let page = 1;
  let batch = first.workflow_runs;
  for (;;) {
    for (const r of batch) seen.set(Number(r.id), trimRun(r));
    if (batch.length < 100 || seen.size >= total || page >= 10) break;
    page += 1;
    batch = (gh.rest(`${base}&page=${page}`) as { workflow_runs: Obj[] }).workflow_runs;
  }
  out.runs.push(...seen.values());
  out.windows.push({ created, total_count: total, fetched: seen.size });
  if (seen.size < total) {
    out.failures.push(
      `Truncated: runs created ${created} report total_count ${total} but ${seen.size} were fetched. The day's numbers would be wrong, so the snapshot is unhealthy; re-run the collector (a shortfall that persists means the window split needs to go finer).`
    );
  }
}

/**
 * Every run created on a day (up to `until` for a day still in progress).
 *
 * @param gh - The client.
 * @param repo - `owner/name`.
 * @param day - The UTC day.
 * @param until - Stop at this instant instead of the end of the day.
 */
function fetchRuns(gh: Gh, repo: string, day: string, until?: Date): RunsFetch {
  const out: RunsFetch = { runs: [], windows: [], failures: [] };
  const from = Date.parse(`${day}T00:00:00Z`);
  const to = until ? Math.min(until.getTime(), from + 86_399_000) : from + 86_399_000;
  fetchRunsWindow(gh, repo, from, Math.floor(to / 1000) * 1000, out);
  const unique = new Map(out.runs.map((r) => [r.id, r]));
  out.runs = [...unique.values()].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id
  );
  return out;
}

// ---------------------------------------------------------------------------
// Jobs per head SHA

interface JobRecord {
  gate: string;
  /** The run's event (pull_request, merge_group, push, ...). */
  event: string;
  runId: number;
  name: string;
  conclusion: string;
  seconds: number | null;
  completedAt: string;
}

const JOB_URL = /\/actions\/runs\/(\d+)\/job\/\d+/;

/**
 * The check runs of one SHA that belong to this day's Actions runs.
 *
 * @param gh - The client.
 * @param repo - `owner/name`.
 * @param sha - The head SHA.
 * @param runsById - This day's runs; a check run from another day's run is skipped.
 * @param mapGate - Resolves the gate id.
 */
function fetchShaJobs(
  gh: Gh,
  repo: string,
  sha: string,
  runsById: ReadonlyMap<number, Run>,
  mapGate: GateMapper
): JobRecord[] {
  const out: JobRecord[] = [];
  let page = 1;
  for (;;) {
    const res = gh.rest(
      `repos/${repo}/commits/${sha}/check-runs?filter=all&per_page=100&page=${page}`
    ) as {
      total_count: number;
      check_runs: Obj[];
    };
    for (const c of res.check_runs) {
      const app = isObj(c.app) ? c.app.slug : undefined;
      if (app !== 'github-actions') continue;
      const m = JOB_URL.exec(String(c.details_url ?? ''));
      const run = m ? runsById.get(Number(m[1])) : undefined;
      if (!run) continue;
      const gate = mapGate(run.path, String(c.name));
      if (!gate || c.status !== 'completed' || typeof c.conclusion !== 'string') continue;
      const started = typeof c.started_at === 'string' ? Date.parse(c.started_at) : NaN;
      const completed = typeof c.completed_at === 'string' ? Date.parse(c.completed_at) : NaN;
      const seconds =
        Number.isFinite(started) && Number.isFinite(completed)
          ? Math.max(0, Math.round((completed - started) / 1000))
          : null;
      out.push({
        gate,
        event: run.event,
        runId: run.id,
        name: String(c.name),
        conclusion: c.conclusion,
        seconds,
        completedAt: String(c.completed_at ?? run.updated_at),
      });
    }
    if (res.check_runs.length < 100 || page * 100 >= res.total_count) break;
    page += 1;
  }
  return out;
}

function addJobs(snap: Snapshot, jobs: readonly JobRecord[]): void {
  const dayMs = Date.parse(`${snap.date}T00:00:00Z`);
  const attempts = new Map<string, number>();
  for (const j of jobs) {
    const g: GateDay = (snap.gates[gateKey(j.gate, j.event)] ??= {
      durations: [],
      conclusions: {},
      retried: 0,
      runs: 0,
    });
    g.runs += 1;
    g.conclusions[j.conclusion] = (g.conclusions[j.conclusion] ?? 0) + 1;
    const key = `${j.runId}/${j.name}`;
    const seen = attempts.get(key) ?? 0;
    if (seen > 0) g.retried += 1;
    attempts.set(key, seen + 1);
    if (j.seconds !== null && j.conclusion !== 'skipped' && j.conclusion !== 'cancelled') {
      // A job that ended after midnight still belongs to the day its run was created.
      g.durations.push([Math.round((Date.parse(j.completedAt) - dayMs) / 1000), j.seconds]);
    }
    if (j.seconds !== null && j.conclusion !== 'skipped') snap.counts.job_minutes += j.seconds / 60;
  }
  snap.counts.job_minutes = round(snap.counts.job_minutes, 1);
}

// ---------------------------------------------------------------------------
// One day

function priorQueueBuilds(
  dataDir: string,
  day: string,
  current: readonly QueueBuild[]
): QueueBuild[] {
  const out = [...current];
  for (let i = 1; i <= 7; i++) {
    const s = readData(dataDir, snapshotPath(addDays(day, -i)), SnapshotSchema);
    if (s) out.push(...s.queue_builds);
  }
  return out;
}

/** The failing gates of a PR's latest red queue build at or before an instant. */
function failingGatesFor(builds: readonly QueueBuild[], pr: number, at: string): string[] {
  const red = builds
    .filter((b) => b.pr === pr && b.outcome === 'red' && b.created_at <= at)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const gates = red.at(-1)?.failed_gates ?? [];
  return gates.length ? gates : ['unattributed'];
}

function collectDay(
  opts: CollectOptions,
  day: string,
  partial: boolean,
  global: GlobalChecks
): Snapshot {
  const { gh, files, workflows, dataDir, now } = opts;
  const { config } = files;
  const repo = config.github_repo;
  const existing = readData(dataDir, snapshotPath(day), SnapshotSchema);
  // Resume only a day that stopped because the budget ran out. A day whose own
  // data was truncated filtered its check runs through an incomplete run list,
  // so its shas_done cannot be trusted: that day starts again from scratch.
  const resume =
    existing && !existing.complete && !existing.partial_day && !existing.truncated
      ? existing
      : null;
  const snap = emptySnapshot(day, now.toISOString(), gh.budget);
  const callsAtStart = gh.calls;
  snap.partial_day = partial;
  if (resume) {
    snap.gates = resume.gates;
    snap.shas_done = resume.shas_done;
    snap.counts.job_minutes = resume.counts.job_minutes;
    snap.counts.test_executions = resume.counts.test_executions;
    snap.counts.test_flaky = resume.counts.test_flaky;
    snap.counts.flaky_builds_sampled = resume.counts.flaky_builds_sampled;
    snap.flaky_tests = resume.flaky_tests;
    snap.flaky_builds = resume.flaky_builds;
  }
  const failures: string[] = [...global.failures];
  // Problems with this day's own data: any one keeps the day incomplete, so
  // the next run fetches it again instead of trusting it forever.
  const dayFailures: string[] = [];
  const warnings: string[] = [];
  const required = requiredWorkflowPaths(workflows, files.requiredChecks?.contexts ?? []);
  const mapGate = gateMapper(workflows);
  const fetched = fetchRuns(gh, repo, day, partial ? now : undefined);
  dayFailures.push(...fetched.failures);
  const runs = fetched.runs.filter((r) => r.head_branch !== config.data_branch);
  snap.health.runs = {
    windows: fetched.windows,
    total_count: fetched.windows.reduce((a, w) => a + w.total_count, 0),
    fetched: fetched.runs.length,
  };

  // Jobs, SHA by SHA, until the budget says stop.
  const runsById = new Map(runs.map((r) => [r.id, r]));
  const shas = [...new Set(runs.map((r) => r.head_sha))];
  const done = new Set(snap.shas_done);
  const failedGates = new Map<string, string[]>();
  for (const b of resume?.queue_builds ?? []) failedGates.set(b.sha, b.failed_gates);
  let late = false;
  for (const sha of shas) {
    if (done.has(sha.slice(0, 12))) continue;
    let jobs: JobRecord[];
    try {
      jobs = fetchShaJobs(gh, repo, sha, runsById, mapGate);
    } catch (e) {
      if (e instanceof BudgetExhausted) {
        late = true;
        break;
      }
      throw e;
    }
    addJobs(snap, jobs);
    const failed = [
      ...new Set(jobs.filter((j) => FAILED.has(j.conclusion)).map((j) => j.gate)),
    ].sort();
    failedGates.set(sha.slice(0, 12), failed);
    snap.shas_done.push(sha.slice(0, 12));
  }
  snap.health.shas = { total: shas.length, done: snap.shas_done.length };
  if (late) {
    warnings.push(
      `Late: the request budget ran out after ${snap.shas_done.length} of ${shas.length} head SHAs; the next run resumes this day where it stopped.`
    );
  }

  // Run-level series (recomputed whole on every pass: runs are cheap to re-read).
  snap.series.pr_feedback_min = prFeedback(runs, required);
  snap.queue_builds = queueBuilds(
    runs,
    required,
    new Map([...failedGates].map(([k, v]) => [k, v]))
  );
  for (const b of snap.queue_builds) {
    if (failedGates.has(b.sha)) b.failed_gates = failedGates.get(b.sha)!;
  }
  snap.counts.queue_builds = snap.queue_builds.length;
  snap.counts.queue_builds_green = snap.queue_builds.filter((b) => b.outcome === 'green').length;
  snap.counts.queue_builds_cancelled = snap.queue_builds.filter(
    (b) => b.outcome === 'cancelled'
  ).length;
  snap.main = mainCommits(runs, config.default_branch);
  snap.canary = canaryRuns(runs, config.default_branch, config.canary.workflows);
  reviews(runs, config.collect.review_workflow, snap);

  // PRs merged this day.
  let prs: PrFacts[] = [];
  try {
    prs = fetchMergedPrs(gh, repo, day, partial ? now : undefined, dayFailures);
  } catch (e) {
    if (!(e instanceof BudgetExhausted)) throw e;
    late = true;
    warnings.push(
      'Late: the request budget ran out before the merged PRs were read; the next run resumes this day.'
    );
  }
  const builds = priorQueueBuilds(dataDir, day, snap.queue_builds);
  snap.counts.merged_prs = prs.length;
  for (const p of prs) {
    const at = secondOfDay(p.mergedAt);
    snap.series.lead_time_min.push([at, p.leadTimeMin]);
    if (p.queueWaitMin !== null) snap.series.queue_wait_min.push([at, p.queueWaitMin]);
    if (p.queueBuildMin !== null) snap.series.queue_build_min.push([at, p.queueBuildMin]);
    if (p.ejections.length && p.queueWaitMin !== null)
      snap.series.queue_wait_ejected_min.push([at, p.queueWaitMin]);
    for (const ej of p.ejections) {
      snap.counts.ejections_failed_checks += 1;
      const gates = failingGatesFor(builds, p.number, ej.at);
      for (const g of gates) snap.ejections_caused[g] = (snap.ejections_caused[g] ?? 0) + 1;
      if (ej.newCommit)
        for (const g of gates) snap.real_catches[g] = (snap.real_catches[g] ?? 0) + 1;
      else snap.counts.wasted_ejections += 1;
    }
  }

  // Flaky tests from a sample of queue builds' reports (artifacts expire after 7 days).
  if (!late) {
    try {
      sampleFlaky(opts, snap, runs);
    } catch (e) {
      if (!(e instanceof BudgetExhausted)) throw e;
      warnings.push(
        'The request budget ran out while sampling test reports; flaky-test-runs has a smaller sample today.'
      );
    }
  }

  snap.releases = global.releases.filter((r) => r.published_at.startsWith(day));
  snap.cache = global.cache;
  // Today's timeouts describe the runs of recent days only; a backfilled day's
  // runs ran under whatever the YAML said then, so headroom does not read them.
  const backfilled = day < addDays(dayOf(now), -files.config.collect.lookback_days);
  snap.timeouts = backfilled ? {} : gateTimeouts(workflows);
  failures.push(...dayFailures);
  snap.truncated = dayFailures.length > 0;
  snap.complete = !late && !partial && !snap.truncated;
  snap.health.ruleset = global.ruleset;
  snap.health.data_rulesets = global.dataRulesets;
  snap.health.failures = failures;
  snap.health.warnings = warnings;
  // This day's own requests; the run's total goes to latest.json.
  snap.health.api_calls = gh.calls - callsAtStart;
  snap.health.ok = failures.length === 0;
  snap.healthy = snap.health.ok;
  return snap;
}

// ---------------------------------------------------------------------------
// Which days, and the run

/**
 * The days a run should collect, most urgent first: yesterday, then missing
 * or late days in the lookback, then backfill days oldest first (their Actions
 * data is the next to expire).
 *
 * @param dataDir - The data branch working tree.
 * @param files - The hand files.
 * @param now - The clock.
 */
export function planDays(dataDir: string, files: HandFiles, now: Date): string[] {
  const cfg = files.config.collect;
  const yesterday = addDays(dayOf(now), -1);
  const have = new Map<string, boolean>();
  for (const d of snapshotDays(dataDir)) {
    const s = readData(dataDir, snapshotPath(d), SnapshotSchema);
    if (s) have.set(d, s.complete);
  }
  const needs = (d: string) => have.get(d) !== true;
  const recent = daysBetween(addDays(yesterday, -(cfg.lookback_days - 1)), yesterday)
    .reverse()
    .filter(needs);
  const oldest = addDays(dayOf(now), -89); // Actions keeps run data for 90 days
  const floor = cfg.backfill_from && cfg.backfill_from > oldest ? cfg.backfill_from : oldest;
  const backfill = cfg.backfill_from
    ? daysBetween(floor, addDays(yesterday, -cfg.lookback_days)).filter(needs)
    : [];
  return [...recent, ...backfill];
}

/**
 * Local-export ages for the health block.
 *
 * @param dataDir - The data branch working tree.
 * @param files - The hand files.
 * @param today - The current UTC day.
 */
function localExportHealth(
  dataDir: string,
  files: HandFiles,
  today: string
): { exports: Health['local_exports']; failures: string[] } {
  const { stale_after_days: stale, retired_after_days: retired } = files.config.local;
  const exports: Health['local_exports'] = {};
  const failures: string[] = [];
  for (const [clone, last] of Object.entries(localExportDays(dataDir))) {
    const age = Math.round(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / 86_400_000
    );
    const state = age > retired ? 'retired' : age > stale ? 'stale' : 'fresh';
    exports[clone] = { last, age_days: age, state };
    if (state === 'stale') {
      failures.push(
        `The local export from clone ${clone} is ${age} days old (last ${last}); local-commit and local-push are going stale. Approve or re-run the ci-local-export scheduled skill on that machine (Schedules page, Full autonomy).`
      );
    }
  }
  return { exports, failures };
}

/**
 * Run the collector: plan the days, collect each one while the budget lasts,
 * write their snapshots.
 *
 * @param opts - The run's inputs.
 */
export function collect(opts: CollectOptions): CollectResult {
  const { dataDir, files, now } = opts;
  mkdirSync(opts.tmpDir, { recursive: true });
  const today = dayOf(now);
  const days = opts.days ? [...opts.days] : planDays(dataDir, files, now);
  if (opts.includeToday && !days.includes(today)) days.unshift(today);
  let global: GlobalChecks;
  try {
    global = globalChecks(opts.gh, files);
  } catch (e) {
    if (!(e instanceof BudgetExhausted)) throw e;
    return {
      planned: days,
      days: [],
      newest: null,
      healthy: false,
      failures: [],
      apiCalls: opts.gh.calls,
    };
  }
  const local = localExportHealth(dataDir, files, today);
  global.failures.push(...local.failures);
  const written: string[] = [];
  const failures = new Set<string>();
  for (const day of days) {
    if (written.length > 0 && opts.gh.budget - opts.gh.calls < 10) break;
    let snap: Snapshot;
    try {
      snap = collectDay(opts, day, day === today, global);
    } catch (e) {
      if (e instanceof BudgetExhausted) break;
      throw e;
    }
    snap.health.local_exports = local.exports;
    writeData(dataDir, snapshotPath(day), snap);
    written.push(day);
    for (const f of snap.health.failures) failures.add(f);
  }
  const all = snapshotDays(dataDir);
  // latest.json never moves back: a run that wrote only backfill days still
  // points at the newest complete day on disk.
  const newest = written.length ? latestDay(dataDir) : null;
  if (newest) {
    const first = all[0]!;
    const from = [addDays(newest, -27), first].sort().at(-1)!;
    const gaps = daysBetween(from, newest).filter((d) => !all.includes(d));
    const snap = readData(dataDir, snapshotPath(newest), SnapshotSchema)!;
    snap.health.series_gaps = gaps;
    snap.health.warnings = snap.health.warnings.filter((w) => !w.startsWith('No snapshot for '));
    if (gaps.length)
      snap.health.warnings.push(
        `${gaps.length} of 28 days missing to ${newest} (${dayRange(gaps)}).`
      );
    writeData(dataDir, snapshotPath(newest), snap);
  }
  return {
    planned: days,
    days: written.sort(),
    newest,
    healthy: failures.size === 0,
    failures: [...failures],
    apiCalls: opts.gh.calls,
  };
}
