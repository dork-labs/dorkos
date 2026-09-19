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
        })
        .strict()
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
    verdicts: z
      .object({
        /** Length of the before-window, anchored on the merge time. */
        before_days: z.number().int().min(1),
        /** Minimum sample for a gate, hook or queue metric; an SLO metric uses its own min_n. */
        min_n: z.number().int().min(1),
      })
      .strict(),
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
      })
      .strict(),
  })
  .strict();
/** Parsed `ci/config.yaml`. */
export type Config = z.infer<typeof ConfigSchema>;

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
