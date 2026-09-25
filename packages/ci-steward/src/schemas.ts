/**
 * Zod schemas for every hand-owned file under `ci/`.
 *
 * These files are the pipeline's stated intent. The census validates all of
 * them on every run, so a typo in a hand file fails the PR that makes it rather
 * than the first scheduled job that reads it days later. Objects are `strict`:
 * an unknown key is almost always a misspelt known one.
 */
import { z } from 'zod';

const RepoPath = z.string().min(1);
const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a date as YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'not a real calendar date');

/** The `collect:` block of `ci/config.yaml`. */
const CollectConfigSchema = z
  .object({
    /** Requests one run may make. GITHUB_TOKEN allows 1,000 an hour; keep well under. */
    api_budget: z.number().int().positive(),
    /** Missing or late days this far back are collected again before anything older. */
    lookback_days: z.number().int().min(1),
    /** Leftover budget fills older days back to this date, oldest first (Actions keeps 90 days). */
    backfill_from: IsoDate.nullable(),
    /** Queue builds per day whose test reports are downloaded for flaky-test-runs. */
    artifact_builds_per_day: z.number().int().min(0),
    /** Workflow file of the automated review, for review-completes and review-recovery. */
    review_workflow: z.string().min(1),
    /** Queue-build artifacts that carry per-test results, and the report format inside each. */
    artifacts: z.array(
      z
        .object({
          workflow: z.string().min(1),
          pattern: z.string().min(1),
          format: z.enum(['playwright', 'vitest']),
          /**
           * The gate whose jobs write these reports. `flaky-test-runs` counts a
           * failed queue job as covered only when its gate is named here; every
           * other failed job is coverage it cannot see, and says so.
           */
          gate: z
            .string()
            .regex(/^wf\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'a wf.<workflow>.<job> gate id'),
        })
        .strict()
    ),
  })
  .strict();

/**
 * The `triage:` block of `ci/config.yaml`: one threshold per improvement
 * trigger (`packages/ci-steward/src/triggers.ts`). It lives in a file the
 * fence covers, so an unattended change cannot widen a threshold to make its
 * own trigger stop firing.
 */
const TriageConfigSchema = z
  .object({
    /** Rule 4: this week's failure rate against last week's, e.g. 1.5 for "half again as often". */
    failure_spike_ratio: z.number().gt(1),
    /** Rule 4: completed runs a gate needs in each week before the ratio means anything. */
    failure_spike_min_n: z.number().int().positive(),
    /** Rule 4's second arm: a failure rate this high fires on its own, so 0% to 50% is not silent. */
    failure_spike_absolute: z.number().gt(0).lte(1),
    /**
     * Rules 4 and 5: days that must have a snapshot in EACH of the two weeks
     * before they may be compared. Without it, 7 days against 1 backfilled day
     * reads as a week-over-week spike.
     */
    spike_min_days: z.number().int().positive(),
    /** Rule 5: fractional growth in a gate's p90 duration week over week, e.g. 0.25. */
    duration_growth: z.number().positive(),
    /** Rule 5: fractional growth in job minutes per merged pull request, e.g. 0.2. */
    minutes_growth: z.number().positive(),
    /** Rule 6: failed-checks ejections one job must cause before it is a class. */
    repeat_ejection_min: z.number().int().positive(),
    /** Rule 6: the window those ejections are counted over, in days. */
    repeat_ejection_days: z.number().int().positive(),
    /** Rule 8: p95 duration over timeout-minutes at or above which a job has no headroom. */
    headroom_ratio: z.number().positive(),
    /** Rule 9: how many recent days are checked for a collector health failure. */
    collector_health_days: z.number().int().positive(),
    /** Rule 10: days past an after-window's close before a missing verdict is stale. */
    stale_verdict_days: z.number().int().positive(),
    /** Rule 10: days a `proposed` entry may sit untouched. */
    stale_proposed_days: z.number().int().positive(),
    /** Rule 11: consecutive red main-canary runs of one workflow before the trigger fires. */
    canary_red_min_runs: z.number().int().positive(),
    /** Rule 11's second arm: hours without a canary result before the schedule is treated as stopped. */
    canary_silent_hours: z.number().int().positive(),
    /** Load average per online core, p90, at or above which a machine is saturated. */
    machine_load_per_core: z.number().positive(),
    /** Available memory in MiB, p10, at or below which a machine is out of memory. */
    machine_mem_available_mb: z.number().positive(),
    /** Swap in use in MiB, p50, at or above which a machine is thrashing. */
    machine_swap_used_mb: z.number().positive(),
    /** Machine readings needed before any of the three above judges anything. */
    machine_load_min_n: z.number().int().positive(),
    /** The report calls out a trigger that has been open this many days or more. */
    open_days_warning: z.number().int().positive(),
    /** Days of history the daily report's sparklines draw. */
    sparkline_days: z.number().int().min(2),
  })
  .strict();

/**
 * The `quarantine:` block of `ci/config.yaml`: every threshold the quarantine
 * lane is fenced by (plan §4.9 L1).
 */
const QuarantineConfigSchema = z
  .object({
    /** Path on the data branch, so quarantining needs no PR. */
    file: RepoPath,
    /** A list longer than this is ignored whole, never trimmed. */
    max_entries: z.number().int().min(1),
    /** Lifetime of an entry when `quarantine add` is not told otherwise. */
    default_expiry_days: z.number().int().min(1),
    /**
     * The longest life any entry may have, enforced at READ time like every
     * other guard. Without it "every entry expires after 7 days" is one
     * `--expiry-days 365` away from false, and the add path is not the fence:
     * the list is editable by anything that can write the data branch.
     */
    max_expiry_days: z.number().int().min(1),
    /** The evidence window `ci-steward flaky` reads. */
    window_days: z.number().int().min(1),
    /** Distinct merge-group SHAs a test must have flaked on to qualify. */
    min_occurrences: z.number().int().min(2),
    /** Clean builds below which a candidate is never called `cooling`. */
    cooling_min_clean_builds: z.number().int().min(1),
    /** The daily triage flags an entry expiring within this many hours. */
    near_expiry_hours: z.number().int().min(1),
  })
  .strict();

/**
 * The `canary:` block of `ci/config.yaml`: which workflow runs count as the
 * main canary.
 *
 * A canary leg is not a separate workflow — it is the same required workflow,
 * on a `schedule` or `workflow_dispatch` event, against the default branch — so
 * nothing in a run identifies it except its file name and its event. This list
 * is what stops `ci-steward.yml`'s own daily tick, `evals.yml` and `codeql.yml`
 * from being read as canary results.
 */
const CanaryConfigSchema = z
  .object({
    /** Workflow file names whose scheduled runs on the default branch are the canary. */
    workflows: z.array(z.string().regex(/^[\w.-]+\.ya?ml$/, 'a workflow file name')).min(1),
    /**
     * Workflows that own a required context and are deliberately NOT in the
     * canary, each with the reason. Every required workflow must be in one list
     * or the other, so dropping a name from `workflows` cannot quietly stop the
     * canary watching it: the census fails until someone writes down why.
     */
    exempt: z.record(
      z.string().regex(/^[\w.-]+\.ya?ml$/, 'a workflow file name'),
      z.string().min(20)
    ),
  })
  .strict();

/** `ci/config.yaml`: everything repo-specific the engine needs. */
export const ConfigSchema = z
  .object({
    version: z.literal(1),
    default_branch: z.string().min(1),
    workflows_dir: RepoPath,
    lefthook: RepoPath,
    claude_settings: RepoPath,
    claude_hook_wrappers: z.array(RepoPath),
    root_package_json: RepoPath,
    data_branch: z.string().min(1),
    /** `owner/name`, for every `gh api` call. */
    github_repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name'),
    /** Weekly backup tags are `<prefix>YYYY-Www`, protected by `data_tag_ruleset_id`. */
    data_tag_prefix: z.string().min(1),
    data_tag_ruleset_id: z.number().int().positive(),
    ruleset: z
      .object({
        id: z.number().int().positive(),
        rules: z.array(z.string().min(1)).min(1),
        integration_id: z.number().int().positive(),
      })
      .strict(),
    data_ruleset_id: z.number().int().positive(),
    hand_files: z
      .object({
        required_checks: RepoPath,
        gates: RepoPath,
        slos: RepoPath,
        metrics: RepoPath,
        ratchets: RepoPath,
        steward_owned_paths: RepoPath,
        census_allowlist: RepoPath,
      })
      .strict(),
    ledger_dir: RepoPath,
    coverage: z.object({ paths: z.array(RepoPath).min(1) }).strict(),
    fence_branch_prefix: z.string().min(1),
    generated_blocks: z.object({ required_checks: z.array(RepoPath) }).strict(),
    commands: z.object({ ledger_new: z.string().min(1), census_fix: z.string().min(1) }).strict(),
    collect: CollectConfigSchema,
    /**
     * Deadlines that fire inside a job before its own `timeout-minutes`, by
     * gate. `headroom` measures a gate against the smaller of the two, because
     * that is the one that ends the run.
     */
    deadlines: z
      .array(
        z
          .object({
            gate: z
              .string()
              .regex(/^wf\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'a wf.<workflow>.<job> gate id'),
            minutes: z.number().positive(),
            /** Where the deadline is set, so a reader can check it. */
            source: z.string().min(1),
          })
          .strict()
      )
      .default([]),
    quarantine: QuarantineConfigSchema,
    canary: CanaryConfigSchema,
    verdicts: z
      .object({
        /** Length of the before-window, anchored on the merge time. */
        before_days: z.number().int().min(1),
        /** Minimum sample for a gate, hook or queue metric; an SLO metric uses its own min_n. */
        min_n: z.number().int().min(1),
      })
      .strict(),
    triage: TriageConfigSchema,
    local: z
      .object({
        /** Under `git rev-parse --git-common-dir`, so every worktree of a clone shares it. */
        timings_file: RepoPath,
        /** A START with no END older than this is a killed run: the agent tool ceiling. */
        killed_after_seconds: z.number().int().positive(),
        /** The agent tool ceiling: what a killed push cost, for the constraint's wait-hours. */
        tool_ceiling_seconds: z.number().int().positive(),
        retention_days: z.number().int().positive(),
        max_bytes: z.number().int().positive(),
        /** An export older than this is a health failure... */
        stale_after_days: z.number().int().positive(),
        /** ...until this old, when the clone is treated as retired and only reported. */
        retired_after_days: z.number().int().positive(),
        /** Heavy local gates allowed to run at once on one machine (scripts/heavy-run-lock.sh). */
        heavy_run_slots: z.number().int().positive(),
        /** How long a heavy gate waits for a slot before running anyway, loudly. */
        heavy_lock_wait_seconds: z.number().int().positive(),
        /** A slot held longer than this is reclaimable even from a live owner. */
        heavy_lock_max_hold_seconds: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();
/** Parsed `ci/config.yaml`. */
export type Config = z.infer<typeof ConfigSchema>;
/** The `quarantine:` block of `ci/config.yaml`. */
export type QuarantineConfig = z.infer<typeof QuarantineConfigSchema>;

/** `ci/required-checks.json`: the required contexts, mirrored from the live ruleset. */
export const RequiredChecksSchema = z
  .object({
    ruleset: z.number().int().positive(),
    contexts: z
      .array(z.string().min(1))
      .min(1)
      .refine((a) => new Set(a).size === a.length, 'contexts must be unique'),
  })
  .strict();
/** Parsed `ci/required-checks.json`. */
export type RequiredChecks = z.infer<typeof RequiredChecksSchema>;

/** The four gate id families. */
const GATE_ID_RE =
  /^(?:wf\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|lefthook\.[a-z-]+\.[A-Za-z0-9_-]+|claude\.[A-Za-z]+\.[A-Za-z0-9_.-]+|ruleset\.[a-z_]+)$/;

/** `ci/gates.yaml`: one `{id, source, purpose}` per gate, nothing generated. */
export const GatesSchema = z
  .object({
    gates: z.array(
      z
        .object({
          id: z.string().regex(GATE_ID_RE, 'not a gate id (wf.*, lefthook.*, claude.*, ruleset.*)'),
          source: RepoPath,
          purpose: z.string().min(10),
        })
        .strict()
    ),
  })
  .strict();
/** Parsed `ci/gates.yaml`. */
export type Gates = z.infer<typeof GatesSchema>;

const Threshold = z
  .object({
    stat: z.string().min(1),
    op: z.enum(['<=', '>=', '<', '>']),
    value: z.number(),
    unit: z.string().min(1),
  })
  .strict();

/** `ci/slos.yaml`: every SLO with its full measurement definition. */
export const SlosSchema = z
  .object({
    slos: z.array(
      z
        .object({
          id: z.string().regex(/^[a-z][a-z0-9-]*$/),
          kind: z.enum(['speed', 'quality', 'tripwire']),
          title: z.string().min(1),
          definition: z
            .object({
              event_source: z.string().min(1),
              population: z.string().min(1),
              exclusions: z.array(z.string().min(1)),
              aggregation: z.string().min(1),
              window: z.string().min(1),
              min_n: z.number().int().positive(),
              fixture: z.string().min(1),
            })
            .strict(),
          today: z.string().min(1),
          floor: z.array(Threshold).nullable(),
          objective: z.array(Threshold).min(1),
          path: z.string().min(1),
        })
        .strict()
    ),
  })
  .strict();
/** Parsed `ci/slos.yaml`. */
export type Slos = z.infer<typeof SlosSchema>;

const MetricTemplate = z
  .object({
    metric: z.string().regex(/^[a-z][a-z0-9_]*$/),
    unit: z.string().min(1),
    definition: z.string().min(1),
  })
  .strict();

/** `ci/metrics.yaml`: every metric id a hypothesis may name. */
export const MetricsSchema = z
  .object({
    gate_templates: z.array(MetricTemplate).min(1),
    /** Events a gate metric may be narrowed to: `gate.<id>.<metric>@<event>`. */
    event_qualifiers: z.array(z.string().regex(/^[a-z_]+$/)).default([]),
    hook_templates: z.array(MetricTemplate).min(1),
    queue: z.array(
      z
        .object({
          id: z.string().regex(/^queue\.[a-z_]+$/),
          unit: z.string().min(1),
          definition: z.string().min(1),
        })
        .strict()
    ),
    tracked: z.array(
      z
        .object({
          id: z.string().regex(/^tracked\.[a-z0-9-]+$/),
          unit: z.string().min(1),
          definition: z.string().min(1),
        })
        .strict()
    ),
    slo_metrics: z.array(z.string().min(1)).min(1),
  })
  .strict();
/** Parsed `ci/metrics.yaml`. */
export type Metrics = z.infer<typeof MetricsSchema>;

/** `ci/ratchets.yaml`: the quality counts that may never silently drop. */
export const RatchetsSchema = z
  .object({
    ratchets: z.array(
      z
        .object({
          id: z.string().regex(/^[a-z][a-z0-9-]*$/),
          kind: z.enum(['floor', 'ceiling', 'set', 'content']),
          scope: z.enum(['per-package', 'per-spec-file', 'repo']),
          description: z.string().min(1),
          measured_from: z.string().min(1),
          enforced_by: z.string().min(1),
          enforced_from_phase: z.number().int().min(0),
          file: RepoPath.optional(),
          must_contain: z.array(z.string().min(1)).optional(),
        })
        .strict()
        .refine(
          (r) =>
            r.kind !== 'content' || (r.file !== undefined && (r.must_contain?.length ?? 0) > 0),
          'a content ratchet needs `file` and at least one `must_contain` string'
        )
    ),
  })
  .strict();
/** Parsed `ci/ratchets.yaml`. */
export type Ratchets = z.infer<typeof RatchetsSchema>;

/** `ci/steward-owned-paths.json`: what an unattended `ci-improve/*` change may not touch. */
export const StewardOwnedPathsSchema = z
  .object({ description: z.string().min(1), paths: z.array(RepoPath).min(1) })
  .strict();
/** Parsed `ci/steward-owned-paths.json`. */
export type StewardOwnedPaths = z.infer<typeof StewardOwnedPathsSchema>;

/** Kinds of census exception. */
const ALLOWLIST_KINDS = ['continue-on-error', 'step-if', 'job-if', 'no-timeout'] as const;
/** Kinds whose entry must carry an `expires` date. */
const EXPIRY_REQUIRED: ReadonlySet<string> = new Set(['no-timeout']);

/** `ci/census-allowlist.yaml`: reasoned exceptions to the census rules. */
export const AllowlistSchema = z
  .object({
    entries: z.array(
      z
        .object({
          workflow: z
            .string()
            .regex(/^[\w.-]+\.ya?ml$/, 'a workflow file name, e.g. typecheck.yml'),
          job: z.string().min(1),
          step: z.string().min(1).optional(),
          kind: z.enum(ALLOWLIST_KINDS),
          reason: z.string().min(20),
          expires: IsoDate.optional(),
        })
        .strict()
        .refine((e) => !EXPIRY_REQUIRED.has(e.kind) || e.expires !== undefined, {
          message: 'this kind of exception must carry `expires: YYYY-MM-DD`',
          path: ['expires'],
        })
    ),
  })
  .strict();
/** Parsed `ci/census-allowlist.yaml`. */
export type Allowlist = z.infer<typeof AllowlistSchema>;
/** One allowlist entry. */
export type AllowlistEntry = Allowlist['entries'][number];

/** Hand states a ledger entry may carry on `main`. */
const LEDGER_STATUSES = ['proposed', 'active', 'withdrawn', 'reverted'] as const;
/** Computed states, which live only on the data branch. */
export const COMPUTED_STATUSES = ['verified', 'partial', 'failed', 'inconclusive'] as const;

/** Frontmatter of one `ci/ledger/<id>-<slug>.md` entry (plan §4.3). */
export const LedgerFrontmatterSchema = z
  .object({
    id: z.string(),
    title: z.string().min(1),
    kind: z.enum(['experiment', 'incident-fix', 'hygiene']),
    status: z.enum(LEDGER_STATUSES),
    actor: z.enum(['agent', 'ci-improve-tick']),
    gates: z.array(z.string()).default([]),
    prs: z.array(z.number().int().positive()).default([]),
    'break-glass': z.boolean().optional(),
    hypothesis: z
      .object({
        metric: z.string().min(1),
        slo: z.string().min(1).optional(),
        baseline: z.number().nullable(),
        baseline_source: z.string().min(1).optional(),
        target: z.number(),
        after_days: z.number().int().min(1).max(90),
      })
      .strict()
      .optional(),
    'ratchet-release': z
      .array(
        z
          .object({
            ratchet: z.string().min(1),
            package: z.string().min(1),
            value: z.number(),
            reason: z.string().min(1),
          })
          .strict()
      )
      .default([]),
    /**
     * Loosening an SLO floor (plan §4.4: floors never loosen without a ledger
     * entry). Applied once by the collector, then recorded in floors.json.
     */
    'floor-release': z
      .array(
        z
          .object({
            slo: z.string().min(1),
            stat: z.string().min(1),
            value: z.number(),
            reason: z.string().min(1),
          })
          .strict()
      )
      .default([]),
    'field-changes': z
      .array(
        z
          .object({
            gate: z.string().min(1),
            field: z.enum(['retries', 'shards', 'timeout-minutes', 'required']),
            from: z.union([z.number(), z.string(), z.boolean(), z.null()]),
            to: z.union([z.number(), z.string(), z.boolean(), z.null()]),
          })
          .strict()
      )
      .default([]),
  })
  .strict();

/** A parsed ledger entry. */
export type LedgerFrontmatter = z.infer<typeof LedgerFrontmatterSchema>;

/**
 * Flatten a zod error into one line per issue, each naming its path.
 *
 * @param error - The error from a failed `safeParse`.
 */
export function describeZodError(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`);
}
