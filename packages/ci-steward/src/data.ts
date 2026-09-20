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

/** One commit on the default branch and whether its push checks went red. */
const MainCommitSchema = z
  .object({ sha: z.string(), at: z.string(), done: z.string(), red: z.boolean() })
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
      })
      .strict(),
    /** Ejections followed by a new commit before re-queue, by the gate that failed (plan §4.2). */
    real_catches: Counts,
    /** Failed-check ejections, by the gate that failed. */
    ejections_caused: Counts,
    queue_builds: z.array(QueueBuildSchema),
    main: z.array(MainCommitSchema),
    releases: z.array(z.object({ tag: z.string(), published_at: z.string() }).strict()),
    cache: z.object({ bytes: z.number(), count: z.number() }).strict().nullable(),
    /** Each gate's timeout-minutes when the day was collected; empty for a backfilled day. */
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
 * Every day-record of a gate in a snapshot, for one event or for all of them.
 *
 * @param gates - A snapshot's `gates`.
 * @param gate - The gate id.
 * @param event - One event, or undefined for every event.
 */
export function gateDays(gates: Snapshot['gates'], gate: string, event?: string): GateDay[] {
  if (event) {
    const g = gates[gateKey(gate, event)];
    return g ? [g] : [];
  }
  return Object.entries(gates).flatMap(([k, v]) => (k.startsWith(`${gate}@`) ? [v] : []));
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

/** `latest.json`: the pointer every reader starts from. Small, so SessionStart can parse it fast. */
export const LatestSchema = z
  .object({
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
  })
  .strict();
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

/** One clone's local hook timings for one day (plan §4.5). */
const LocalDaySchema = z
  .object({
    schema: z.literal(1),
    clone: z.string(),
    date: z.string(),
    exported_at: z.string(),
    /** hook -> whole-hook runs: `[start second of day, wall seconds]` of finished runs, runs killed (START, no END, past the ceiling), and runs with a failing command. */
    hooks: z.record(
      z.string(),
      z.object({ durations: Timed, killed: z.number(), failed: z.number() }).strict()
    ),
    /** hook.command -> the same, per lefthook command. */
    commands: z.record(
      z.string(),
      z.object({ durations: Timed, killed: z.number(), failed: z.number() }).strict()
    ),
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
    },
    real_catches: {},
    ejections_caused: {},
    queue_builds: [],
    main: [],
    releases: [],
    cache: null,
    timeouts: {},
  };
}
