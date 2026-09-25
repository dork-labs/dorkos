/**
 * The files the engine writes to the `ci-steward-data` branch (plan §4), with
 * their schemas, and the helpers that read and write them in a working tree of
 * that branch.
 *
 *   latest.json                     pointer: newest snapshot, report_ref, alert summary
 *   snapshots/YYYY-MM-DD.json       one UTC day of observations
 *   verdicts/<ledger-id>.json       computed verdicts
 *   floors.json                     current SLO floors and their weekly history
 *   reports/YYYY-Www.md             the weekly report
 *   local/<clone>/YYYY-MM-DD.json   local hook timings from one clone
 *
 * Every file carries `schema: 1`. A reader validates what it reads, so a
 * snapshot written by an older engine fails by name instead of as NaN.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const Counts = z.record(z.string(), z.number());
/**
 * A timed sample: `[second of the snapshot's UTC day, value]`. The time is what
 * lets a verdict cut its windows at the merge instant rather than at midnight.
 */
const Timed = z.array(z.tuple([z.number(), z.number()]));
/** A timed sample. */
export type TimedSample = [number, number];

/** One gate's observations on one day, for one event. */
const GateDaySchema = z
  .object({
    /** `[end second of day, seconds]` of completed runs that were neither skipped nor cancelled. */
    durations: Timed,
    /** Runs by conclusion: success, failure, cancelled, skipped, timed_out, other. */
    conclusions: Counts,
    /** Runs whose run_attempt was above 1. */
    retried: z.number(),
    /** Every run seen, whatever its conclusion. */
    runs: z.number(),
  })
  .strict();
/** One gate's observations on one day. */
export type GateDay = z.infer<typeof GateDaySchema>;

/** A merge-queue build (one `gh-readonly-queue/*` head SHA). */
const QueueBuildSchema = z
  .object({
    sha: z.string(),
    pr: z.number().nullable(),
    created_at: z.string(),
    /** green, red, cancelled or pending, over the required workflows. */
    outcome: z.enum(['green', 'red', 'cancelled', 'pending']),
    failed_gates: z.array(z.string()),
  })
  .strict();
/** A merge-queue build. */
export type QueueBuild = z.infer<typeof QueueBuildSchema>;

/**
 * The events a main-canary run arrives on.
 *
 * The canary is the required suites run against `main` HEAD on a schedule
 * (`.github/workflows/test.yml` and its three siblings). It reuses the existing
 * workflows, so its jobs carry the SAME gate ids as the PR and queue legs and
 * are told apart only by the run's event — which is why every reader that
 * aggregates a gate across events has to skip these two. A canary run is a
 * diagnostic on a tree nobody is trying to merge: counting it as a failure of
 * `wf.test.test-shard` would move a number that is supposed to describe what
 * merging costs.
 */
export const CANARY_EVENTS: ReadonlySet<string> = new Set(['schedule', 'workflow_dispatch']);

/** The events a change rides to `main`: what a gate costs is measured over these. */
const MERGE_EVENTS: ReadonlySet<string> = new Set(['pull_request', 'merge_group']);

/** One main-canary run: one required workflow, once, against `main` HEAD. */
const CanaryRunSchema = z
  .object({
    /** The workflow file name, e.g. `test.yml`. */
    workflow: z.string(),
    /** The `main` commit it ran against, short. */
    sha: z.string(),
    /** `schedule` or `workflow_dispatch`. */
    event: z.string(),
    started: z.string(),
    done: z.string(),
    /** The run failed or timed out. Cancelled and skipped runs are not recorded at all. */
    red: z.boolean(),
  })
  .strict();
/** One main-canary run. */
export type CanaryRun = z.infer<typeof CanaryRunSchema>;

/**
 * One commit on the default branch and whether its push checks went red.
 *
 * `workflows` says which push workflows ran on it and whether each went red,
 * keyed by file name. It is what lets a red spell end only when the workflow
 * that FAILED goes green again, rather than at the next commit whose push
 * checks happened to be a different, path-filtered set (`mainEpisodes`).
 * Optional, because commits collected before it existed have only `red`; the
 * collector refreshes those days (`refreshOlderDays` in refresh.ts) while Actions
 * still keeps their runs.
 */
const MainCommitSchema = z
  .object({
    sha: z.string(),
    at: z.string(),
    done: z.string(),
    red: z.boolean(),
    workflows: z.record(z.string(), z.boolean()).optional(),
  })
  .strict();
/** One commit on the default branch. */
export type MainCommit = z.infer<typeof MainCommitSchema>;

/** The health block (plan §4.4). `ok` false makes the run red and the snapshot unhealthy. */
const HealthSchema = z
  .object({
    ok: z.boolean(),
    /** Each problem that made the run red, as one sentence naming the fix. */
    failures: z.array(z.string()),
    /** Worth knowing, never red: a late day, a thin sample, an unmeasured SLO. */
    warnings: z.array(z.string()),
    api_calls: z.number(),
    api_budget: z.number(),
    runs: z
      .object({
        windows: z.array(
          z.object({ created: z.string(), total_count: z.number(), fetched: z.number() }).strict()
        ),
        total_count: z.number(),
        fetched: z.number(),
      })
      .strict(),
    shas: z.object({ total: z.number(), done: z.number() }).strict(),
    min_n: z.record(z.string(), z.object({ n: z.number(), min_n: z.number() }).strict()),
    series_gaps: z.array(z.string()),
    local_exports: z.record(
      z.string(),
      z
        .object({
          last: z.string(),
          age_days: z.number(),
          state: z.enum(['fresh', 'stale', 'retired']),
        })
        .strict()
    ),
    ruleset: z
      .object({
        id: z.number(),
        ok: z.boolean(),
        problems: z.array(z.string()),
      })
      .strict()
      .nullable(),
    data_rulesets: z.array(
      z.object({ id: z.number(), ok: z.boolean(), problems: z.array(z.string()) }).strict()
    ),
  })
  .strict();
/** The health block. */
export type Health = z.infer<typeof HealthSchema>;

/**
 * One test that failed and then passed on one queue build's tree.
 *
 * Named, not merely counted: `counts.test_flaky` says how much flake there is,
 * and only these say WHICH tests, which is the whole input to the quarantine
 * classifier (`ci-steward flaky`). Deduplicated per (test, SHA) by the
 * collector, so three shards of one build are one occurrence.
 */
const FlakyTestSchema = z
  .object({
    runner: z.enum(['playwright', 'vitest']),
    /** Playwright: relative to apps/e2e/tests. Vitest: relative to the repo root. */
    file: z.string(),
    title: z.string(),
    /** The merge-group build's head SHA, short. */
    sha: z.string(),
  })
  .strict();
/** One test that failed and then passed on one queue build's tree. */
export type FlakyTest = z.infer<typeof FlakyTestSchema>;

/** One UTC day of observations. */
export const SnapshotSchema = z
  .object({
    schema: z.literal(1),
    date: z.string(),
    collected_at: z.string(),
    /** Every head SHA's jobs were fetched. False means late: the next run resumes it. */
    complete: z.boolean(),
    /** Collected for a day still in progress (a pulse), never published. */
    partial_day: z.boolean(),
    /**
     * This day's own data came back short (runs below total_count, or the
     * merged-PR search below its count). Never resumed: the next run starts the
     * day over, because what it already counted was filtered through a short list.
     */
    truncated: z.boolean().default(false),
    healthy: z.boolean(),
    health: HealthSchema,
    /** Short SHAs whose jobs are already counted, so a late day resumes without double counting. */
    shas_done: z.array(z.string()),
    /** Keyed `<gate-id>@<event>` (see `gateKey`). */
    gates: z.record(z.string(), GateDaySchema),
    series: z
      .object({
        pr_feedback_min: Timed,
        queue_build_min: Timed,
        queue_wait_min: Timed,
        queue_wait_ejected_min: Timed,
        lead_time_min: Timed,
        review_recovery_min: Timed,
      })
      .strict(),
    counts: z
      .object({
        merged_prs: z.number(),
        queue_builds: z.number(),
        queue_builds_green: z.number(),
        queue_builds_cancelled: z.number(),
        ejections_failed_checks: z.number(),
        wasted_ejections: z.number(),
        review_shas: z.number(),
        review_first_ok: z.number(),
        /** Head SHAs whose first review was cancelled (superseded or the label race): outside review-completes. */
        review_cancelled: z.number(),
        review_runs: z.number(),
        test_executions: z.number(),
        test_flaky: z.number(),
        flaky_builds_sampled: z.number(),
        job_minutes: z.number(),
        /**
         * Runner minutes the main canary spent, kept OUT of `job_minutes`.
         * Defaulted, because snapshots written before the canary have no key.
         */
        canary_minutes: z.number().default(0),
        /**
         * Failed-checks ejections that repeat an earlier one on the same PR
         * head (`tracked.repeat-ejections`, `repeatEjections` in ejection-facts.ts).
         * Absent, not 0, on a day collected before it was computed: a day that
         * was never measured must not read as a day with no repeats.
         */
        repeat_ejections: z.number().optional(),
      })
      .strict(),
    /** Which tests flaked, on which build. Defaulted, so snapshots written before it read fine. */
    flaky_tests: z.array(FlakyTestSchema).default([]),
    /**
     * The queue builds whose reports were read, per runner: the denominator for
     * a flake rate, and the order `clean_builds_since` is measured in. Kept per
     * runner because the two suites sample different builds, and counting one
     * runner's builds against the other's flake would make a quiet browser test
     * look fixed every time vitest ran.
     */
    flaky_builds: z
      .array(z.object({ sha: z.string(), runner: z.enum(['playwright', 'vitest']) }).strict())
      .default([]),
    /** Ejections followed by a new commit before re-queue, by the gate that failed (plan §4.2). */
    real_catches: Counts,
    /** Failed-check ejections, by the gate that failed. */
    ejections_caused: Counts,
    queue_builds: z.array(QueueBuildSchema),
    main: z.array(MainCommitSchema),
    /**
     * Completed main-canary runs of the day, oldest first. Defaulted, because
     * every snapshot written before the canary existed has no such key.
     */
    canary: z.array(CanaryRunSchema).default([]),
    releases: z.array(z.object({ tag: z.string(), published_at: z.string() }).strict()),
    cache: z.object({ bytes: z.number(), count: z.number() }).strict().nullable(),
    /**
     * Each gate's deadline when the day was collected: its timeout-minutes, or
     * an inner deadline that fires first (`deadlines:` in ci/config.yaml).
     * Empty for a backfilled day.
     */
    timeouts: z.record(z.string(), z.number()),
  })
  .strict();
/** One UTC day of observations. */
export type Snapshot = z.infer<typeof SnapshotSchema>;

/**
 * A snapshot's gate key: `<gate-id>@<event>`, so the PR leg and the queue leg
 * of one gate stay apart (a sharded suite runs very differently on each).
 *
 * @param gate - The gate id.
 * @param event - The run's event.
 */
export function gateKey(gate: string, event: string): string {
  return `${gate}@${event}`;
}

/**
 * The gates that ran on the merge path anywhere in a window.
 *
 * The main canary runs the required workflows against `main` HEAD, so its runs
 * carry the SAME gate ids as the PR and queue legs and are told apart only by
 * the event. For a gate that also runs on the merge path those canary samples
 * are a different population — a diagnostic on a tree nobody is trying to merge
 * — and counting them would move numbers that describe what merging costs.
 *
 * For a gate that runs on NOTHING BUT a schedule, the canary events are its
 * whole population. `wf.merge-tail.arm`, `wf.evals.structural`,
 * `wf.codeql.analyze` and `wf.ci-steward.collect` are all of that shape, and
 * dropping them outright would make `headroom` — the tripwire that catches a
 * job about to be killed by its own timeout — blind to every one of them.
 *
 * ACROSS THE WHOLE WINDOW, so membership cannot flip day to day, and counting
 * only runs that DID SOMETHING. Both halves are load-bearing, and the second
 * one is the half that is easy to get wrong.
 *
 * The live shape is not a zero-run key. `wf.evals.structural@pull_request`
 * carries `runs: 32` with `conclusions: {skipped: 32}` on all 15 days it
 * appears, and there is no zero-run merge-event key in any snapshot at all. A
 * `runs > 0` test therefore passes, the gate joins the merge-path set on the
 * strength of 32 jobs that never ran, and every one of its scheduled durations
 * is dropped. A job GitHub skipped is not evidence that a gate runs on the
 * merge path; it is evidence that it does not.
 *
 * WHERE THAT ACTUALLY SHOWS. Not in `headroom`: the label- and dispatch-gated
 * gates this rescues sit below that SLO's `min_n`, so its reading is identical
 * under either predicate and quoting a headroom delta here would be quoting a
 * number that never moved. It shows one layer down, where nothing filters by
 * sample count — the per-gate durations a `gate-cost` comparison and a
 * `gate.<id>.duration_p90` hypothesis read, and the failure rates
 * `gate-failure-spike` reads. A gate whose only real runs are scheduled would
 * otherwise have had no duration population at all.
 *
 * @param snaps - Every snapshot in the window being read.
 */
export function mergePathGates(snaps: readonly Snapshot[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const s of snaps)
    for (const [k, g] of Object.entries(s.gates)) {
      const at = k.lastIndexOf('@');
      const real = g.runs - (g.conclusions.skipped ?? 0);
      if (at < 0 || real <= 0) continue;
      if (MERGE_EVENTS.has(k.slice(at + 1))) out.add(k.slice(0, at));
    }
  return out;
}

/**
 * Whether a snapshot gate key belongs in its gate's merge-path population.
 *
 * @param onPath - The window's merge-path gates, from `mergePathGates`.
 * @param key - A `<gate-id>@<event>` key.
 */
export function onMergePath(onPath: ReadonlySet<string>, key: string): boolean {
  const at = key.lastIndexOf('@');
  if (at < 0 || !CANARY_EVENTS.has(key.slice(at + 1))) return true;
  return !onPath.has(key.slice(0, at));
}

/**
 * Every day-record of a gate in a snapshot, for one event or for all of them.
 *
 * "All of them" is every event in the gate's merge-path population, which for a
 * gate that also runs on a PR or in the queue excludes the main canary's own
 * runs of it (`onMergePath`). Asking for a canary event by name still returns
 * it, so a hypothesis written `…@schedule` reads the canary leg on purpose.
 *
 * @param gates - A snapshot's `gates`.
 * @param gate - The gate id.
 * @param event - One event, or undefined for the gate's merge-path population.
 * @param onPath - The window's merge-path gates (`mergePathGates`). Omitting it
 *   reads every event, which is right only when there is no window to compute
 *   one over.
 */
export function gateDays(
  gates: Snapshot['gates'],
  gate: string,
  event?: string,
  onPath?: ReadonlySet<string>
): GateDay[] {
  if (event) {
    const g = gates[gateKey(gate, event)];
    return g ? [g] : [];
  }
  return Object.entries(gates).flatMap(([k, v]) =>
    k.startsWith(`${gate}@`) && (!onPath || onMergePath(onPath, k)) ? [v] : []
  );
}

/** One SLO's reading over a window. */
const SloReadingSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['speed', 'quality', 'tripwire']),
    from: z.string(),
    to: z.string(),
    n: z.number(),
    min_n: z.number(),
    /** Stat name to value; a stat with no data is absent. */
    stats: z.record(z.string(), z.number()),
    /** met: objective met; ok: floor met; breach: floor missed; insufficient: n below min_n; unmeasured: no source yet. */
    status: z.enum(['met', 'ok', 'breach', 'insufficient', 'unmeasured']),
    /** Excess wait-hours against the objective (speed SLOs and wasted-queue-builds), for the constraint. */
    excess_hours: z.number().nullable(),
    note: z.string().optional(),
  })
  .strict();
/** One SLO's reading over a window. */
export type SloReading = z.infer<typeof SloReadingSchema>;

/** The constraint the report names (plan §4.4). */
const ConstraintSchema = z
  .object({
    tier: z.enum(['tripwire', 'quality', 'speed', 'none']),
    id: z.string().nullable(),
    reason: z.string(),
  })
  .strict();
/** The constraint. */
export type Constraint = z.infer<typeof ConstraintSchema>;

/**
 * `latest.json`: the pointer every reader starts from. Small, so SessionStart
 * can parse it fast.
 *
 * **Not `strict`, on purpose.** Every other file here rejects an unknown key,
 * because an unknown key is almost always a misspelt known one. This file is
 * read by whatever checkout an agent happens to be sitting in, which may be
 * days behind the collector that wrote it, and a strict reader turns a new
 * field into "this file needs a migration" in a worktree that did nothing
 * wrong. A field added here is additive from now on; a reader that does not
 * know it ignores it.
 */
/**
 * What the machines running the hooks were doing over a window: the tracked
 * metric `tracked.machine-load` and its two memory companions.
 *
 * Each statistic is read at its own bad end (see `machineReading`), and is
 * `null` when nothing reported it rather than 0, which would read as a
 * measurement. `n` counts readings, not runs; `clones` is how many machines
 * they came from, because a number pooled across two machines describes
 * neither.
 */
export const MachineReadingSchema = z
  .object({
    n: z.number(),
    clones: z.number(),
    /** Load average divided by online cores, p90. */
    load_per_core_p90: z.number().nullable(),
    /** Available memory in MiB, p10 — the low end, where it hurt. */
    mem_available_mb_p10: z.number().nullable(),
    /** Swap in use in MiB, p50 — sustained swap, not a spike. */
    swap_used_mb_p50: z.number().nullable(),
  })
  .strict();

/** What the machines running the hooks were doing. */
export type MachineReading = z.infer<typeof MachineReadingSchema>;

export const LatestSchema = z.object({
  schema: z.literal(1),
  date: z.string(),
  collected_at: z.string(),
  snapshot: z.string(),
  report_ref: z.string().nullable(),
  healthy: z.boolean(),
  failures: z.array(z.string()),
  warnings: z.array(z.string()),
  api_calls: z.number(),
  slos: z.array(SloReadingSchema),
  constraint: ConstraintSchema,
  /** Local SLOs (local-commit, local-push) in breach, for the SessionStart line. */
  local_breaches: z.array(z.string()),
  /**
   * What the machines running the hooks were doing over the same window. A
   * local SLO reads mostly as a fact about the box, and until DOR-2160 nothing
   * recorded the box. Absent on days collected before that.
   */
  machine: MachineReadingSchema.optional(),
  /** Both data-branch rulesets present and unchanged. */
  safeguards_ok: z.boolean(),
  /**
   * What `triage` found, so SessionStart and `/ci-status` see an open red
   * trigger without opening a second file. Absent until the day's triage has
   * run (collect writes latest.json first, triage fills this in after).
   */
  triggers: z
    .object({ red: z.number(), amber: z.number(), top: z.string().nullable() })
    .strict()
    .optional(),
});

/** `latest.json`. */
export type Latest = z.infer<typeof LatestSchema>;

/** Final verdicts, plus `pending` while the after-window is still open. */
const VERDICTS = ['verified', 'partial', 'failed', 'inconclusive', 'pending'] as const;

/** A verdict window, `[from, to)` as ISO instants. */
const WindowReading = z
  .object({
    from: z.string(),
    to: z.string(),
    n: z.number(),
    value: z.number().nullable(),
  })
  .strict();

/** `verdicts/<ledger-id>.json`. */
export const VerdictSchema = z
  .object({
    schema: z.literal(1),
    id: z.string(),
    verdict: z.enum(VERDICTS),
    /** Why, in one sentence: the confounder or thin sample for inconclusive, the numbers otherwise. */
    reason: z.string(),
    computed_at: z.string(),
    /** A digest of the hypothesis; a final verdict is recomputed only when the hypothesis changes. */
    hypothesis_hash: z.string(),
    metric: z.string(),
    anchor: z.string(),
    prs: z.array(z.number()),
    baseline: z
      .object({ value: z.number().nullable(), source: z.enum(['before-window', 'ledger']) })
      .strict(),
    target: z.number(),
    min_n: z.number(),
    before: WindowReading,
    after: WindowReading,
    confounders: z.array(z.string()),
    slo: z
      .object({
        id: z.string(),
        before: z.number().nullable(),
        after: z.number().nullable(),
        stat: z.string(),
        movement: z.enum(['better', 'worse', 'flat', 'unknown']),
      })
      .strict()
      .nullable(),
  })
  .strict();
/** One computed verdict. */
export type Verdict = z.infer<typeof VerdictSchema>;

/** `floors.json`: each SLO's current floor and its weekly readings. */
export const FloorsSchema = z
  .object({
    schema: z.literal(1),
    updated_at: z.string(),
    slos: z.record(
      z.string(),
      z
        .object({
          /** stat -> current floor value; starts at ci/slos.yaml's floor. */
          floor: z.record(z.string(), z.number()),
          /** Newest last: one reading per closed ISO week. */
          weeks: z.array(
            z
              .object({
                week: z.string(),
                status: z.enum(['met', 'ok', 'breach', 'insufficient', 'unmeasured']),
              })
              .strict()
          ),
          /** When and why the floor last moved. */
          moved: z
            .array(
              z
                .object({
                  week: z.string(),
                  stat: z.string(),
                  from: z.number(),
                  to: z.number(),
                  why: z.string(),
                })
                .strict()
            )
            .default([]),
        })
        .strict()
    ),
  })
  .strict();
/** `floors.json`. */
export type Floors = z.infer<typeof FloorsSchema>;

/**
 * One hook's, or one command's, runs in a day.
 *
 * `killed` is the OS taking the process away — on the machine this was written
 * for, memory pressure. `notes` counts what an exit status cannot carry, keyed
 * by the note the time-wrap recorded: `lock_timeout` for a heavy command that
 * gave up waiting for a machine-wide slot and ran uncapped, `lock_wait` for one
 * that waited and got a slot. A cap that stopped capping has to be a number
 * here, or it is indistinguishable from a machine that was never busy.
 * Optional, for days exported before DOR-2160.
 */
const LocalBucketSchema = z
  .object({
    durations: Timed,
    killed: z.number(),
    failed: z.number(),
    notes: z.record(z.string(), z.number()).optional(),
  })
  .strict();

/** One clone's local hook timings for one day (plan §4.5). */
const LocalDaySchema = z
  .object({
    schema: z.literal(1),
    clone: z.string(),
    date: z.string(),
    exported_at: z.string(),
    /** hook -> whole-hook runs: `[start second of day, wall seconds]` of finished runs, runs killed (START, no END, past the ceiling), and runs with a failing command. */
    hooks: z.record(z.string(), LocalBucketSchema),
    /** hook.command -> the same, per lefthook command. */
    commands: z.record(z.string(), LocalBucketSchema),
    /**
     * The machine as the day's hook events saw it, `[start second of day,
     * value]`: load average per core, available memory in MiB, swap in use in
     * MiB. Optional, because days exported before DOR-2160 carry none — and a
     * platform that will not answer one probe still sends the others.
     */
    machine: z
      .object({ load_per_core: Timed, mem_available_mb: Timed, swap_used_mb: Timed })
      .strict()
      .optional(),
  })
  .strict();
/** One clone's local hook timings for one day. */
export type LocalDay = z.infer<typeof LocalDaySchema>;

/**
 * Read and validate a JSON file under the data directory.
 *
 * @param dataDir - A working tree of the data branch.
 * @param rel - Path inside it.
 * @param schema - Its schema.
 * @returns `null` when the file does not exist.
 */
export function readData<S extends z.ZodType>(
  dataDir: string,
  rel: string,
  schema: S
): z.infer<S> | null {
  const abs = path.join(dataDir, rel);
  if (!existsSync(abs)) return null;
  const parsed = schema.safeParse(JSON.parse(readFileSync(abs, 'utf8')));
  if (!parsed.success) {
    const issues = parsed.error.issues;
    const first = issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(
      `${rel} on the data branch does not match its schema (${issues.length} problem${issues.length === 1 ? '' : 's'}; first: ${first.join('; ')}). A file written by a different engine version needs a migration, not a hand edit.`
    );
  }
  return parsed.data;
}

/**
 * Write a JSON or text file under the data directory, creating folders.
 *
 * @param dataDir - A working tree of the data branch.
 * @param rel - Path inside it.
 * @param value - An object (written as pretty JSON with a trailing newline) or a string.
 */
export function writeData(dataDir: string, rel: string, value: unknown): void {
  const abs = path.join(dataDir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, typeof value === 'string' ? value : `${JSON.stringify(value, null, 1)}\n`);
}

/** Path of a day's snapshot. */
export const snapshotPath = (day: string): string => `snapshots/${day}.json`;

/**
 * Every snapshot day on disk, oldest first.
 *
 * @param dataDir - A working tree of the data branch.
 */
export function snapshotDays(dataDir: string): string[] {
  const dir = path.join(dataDir, 'snapshots');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((n) => (/^\d{4}-\d{2}-\d{2}\.json$/.test(n) ? [n.slice(0, 10)] : []))
    .sort();
}

/**
 * Load the snapshots for a span of days; a day with no file is simply absent.
 *
 * @param dataDir - A working tree of the data branch.
 * @param days - The days wanted.
 */
export function loadSnapshots(dataDir: string, days: readonly string[]): Snapshot[] {
  return days.flatMap((d) => {
    const s = readData(dataDir, snapshotPath(d), SnapshotSchema);
    return s ? [s] : [];
  });
}

/**
 * Every clone's local export for a span of days.
 *
 * @param dataDir - A working tree of the data branch.
 * @param days - The days wanted.
 */
export function loadLocalDays(dataDir: string, days: readonly string[]): LocalDay[] {
  const root = path.join(dataDir, 'local');
  if (!existsSync(root)) return [];
  const want = new Set(days);
  const out: LocalDay[] = [];
  for (const clone of readdirSync(root).sort()) {
    const dir = path.join(root, clone);
    for (const f of existsSync(dir) ? readdirSync(dir).sort() : []) {
      const d = f.replace(/\.json$/, '');
      if (!want.has(d)) continue;
      const v = readData(dataDir, `local/${clone}/${f}`, LocalDaySchema);
      if (v) out.push(v);
    }
  }
  return out;
}

/**
 * `local/<clone>/exported.json`: written by every export run, even one with no
 * finished day to send, so a clone that is merely idle (no commits, no pushes)
 * never reads as a stale export.
 */
const LocalHeartbeatSchema = z
  .object({ schema: z.literal(1), clone: z.string(), exported_at: z.string() })
  .strict();

/**
 * When each clone under `local/` last exported: its heartbeat's day, or, for a
 * clone that predates heartbeats, its newest day file.
 *
 * @param dataDir - A working tree of the data branch.
 */
export function localExportDays(dataDir: string): Record<string, string> {
  const root = path.join(dataDir, 'local');
  if (!existsSync(root)) return {};
  const out: Record<string, string> = {};
  for (const clone of readdirSync(root).sort()) {
    const beat = readData(dataDir, `local/${clone}/exported.json`, LocalHeartbeatSchema);
    const days = readdirSync(path.join(root, clone))
      .flatMap((f) => (/^\d{4}-\d{2}-\d{2}\.json$/.test(f) ? [f.slice(0, 10)] : []))
      .sort();
    const last = [beat?.exported_at.slice(0, 10), days.at(-1)]
      .filter((d): d is string => !!d)
      .sort()
      .at(-1);
    if (last) out[clone] = last;
  }
  return out;
}

/**
 * The day `latest.json` should point at: the newest complete snapshot, or the
 * newest of any when none is complete. Never simply the newest day a run
 * wrote, because a backfill run writes only old days, and a pointer that moved
 * back to August would make every reader treat August as current.
 *
 * @param dataDir - A working tree of the data branch.
 */
export function latestDay(dataDir: string): string | null {
  const days = snapshotDays(dataDir);
  for (const d of [...days].reverse()) {
    if (readData(dataDir, snapshotPath(d), SnapshotSchema)?.complete) return d;
  }
  return days.at(-1) ?? null;
}

/** An empty snapshot for a day, before anything is collected into it. */
export function emptySnapshot(day: string, collectedAt: string, budget: number): Snapshot {
  return {
    schema: 1,
    date: day,
    collected_at: collectedAt,
    complete: false,
    partial_day: false,
    truncated: false,
    healthy: false,
    health: {
      ok: false,
      failures: [],
      warnings: [],
      api_calls: 0,
      api_budget: budget,
      runs: { windows: [], total_count: 0, fetched: 0 },
      shas: { total: 0, done: 0 },
      min_n: {},
      series_gaps: [],
      local_exports: {},
      ruleset: null,
      data_rulesets: [],
    },
    shas_done: [],
    gates: {},
    series: {
      pr_feedback_min: [],
      queue_build_min: [],
      queue_wait_min: [],
      queue_wait_ejected_min: [],
      lead_time_min: [],
      review_recovery_min: [],
    },
    counts: {
      merged_prs: 0,
      queue_builds: 0,
      queue_builds_green: 0,
      queue_builds_cancelled: 0,
      ejections_failed_checks: 0,
      wasted_ejections: 0,
      review_shas: 0,
      review_first_ok: 0,
      review_cancelled: 0,
      review_runs: 0,
      test_executions: 0,
      test_flaky: 0,
      flaky_builds_sampled: 0,
      job_minutes: 0,
      canary_minutes: 0,
    },
    flaky_tests: [],
    flaky_builds: [],
    real_catches: {},
    ejections_caused: {},
    queue_builds: [],
    main: [],
    canary: [],
    releases: [],
    cache: null,
    timeouts: {},
  };
}
