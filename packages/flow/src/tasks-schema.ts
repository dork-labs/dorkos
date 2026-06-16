/**
 * Canonical Zod schema for `specs/<slug>/03-tasks.json` — the single source of
 * truth for task decomposition (§8) — plus the PM-agnostic **provenance block**
 * that replaces today's scalar `linear-issue:` frontmatter.
 *
 * ## Collapse the dual task system (the contract)
 *
 * `03-tasks.json` is **canonical**. The built-in Task API is a *projection* for
 * live display only — never a second source of truth. The active phase is
 * mirrored into the tracker as a checklist **generated from `03-tasks.json`,
 * never hand-edited**. Downstream tooling reads this schema to render that
 * projection; nothing writes task state anywhere but the decomposition file.
 *
 * ## The task→issue mapping lives here, and ONLY here
 *
 * Each task may carry optional {@link TaskSchema | `issue`} and `parentIssue`
 * fields — the *only* home for the task→issue mapping. A flat top-level
 * `issues: […]` list is explicitly **rejected** (`.strict()` on
 * {@link TasksFileSchema}): it would duplicate the task→issue map and
 * reintroduce drift.
 *
 * ## Sub-issue promotion is the rare exception
 *
 * A task is promotable to its own tracker sub-issue **only** when
 * `size ≥ decomposition.subIssueThreshold` (default `"xl"`); parent size does
 * not additionally gate. See {@link isPromotableToSubIssue}. The vast majority
 * of tasks stay checklist lines mirrored into the ticket.
 *
 * @see specs/unified-workflow-system/02-specification.md §8 (decomposition, provenance, link cardinality)
 * @see ./config-schema.ts {@link SubIssueThresholdSchema} (the size scale & default threshold)
 * @module @dorkos/flow/tasks-schema
 */

import { z } from 'zod';
import { SubIssueThresholdSchema } from './config-schema.js';

/**
 * Canonical task-size scale, shared with
 * {@link SubIssueThresholdSchema | `decomposition.subIssueThreshold`}. The
 * `>= xl` promotion rule (§7.6) compares against this ordered scale.
 */
export const CANONICAL_SIZE_ORDER = ['xs', 'sm', 'md', 'lg', 'xl'] as const;

/**
 * Legacy human-readable size vocabulary emitted by the existing
 * `/spec:decompose` tooling (`small`/`medium`/`large`). Normalized onto the
 * {@link CANONICAL_SIZE_ORDER} so historical `03-tasks.json` files round-trip
 * unchanged while the promotion rule still compares a single ordinal scale.
 */
const LEGACY_SIZE_TO_CANONICAL = {
  small: 'sm',
  medium: 'md',
  large: 'lg',
} as const satisfies Record<string, (typeof CANONICAL_SIZE_ORDER)[number]>;

/** A canonical size value (`xs`–`xl`). */
export type CanonicalSize = (typeof CANONICAL_SIZE_ORDER)[number];

/**
 * Per-task `size`. Accepts the canonical `xs`–`xl` scale AND the legacy
 * `small`/`medium`/`large` vocabulary so existing decomposition files parse
 * unchanged. Use {@link normalizeSize} before any ordinal comparison.
 */
export const TaskSizeSchema = z.enum([
  ...CANONICAL_SIZE_ORDER,
  ...(Object.keys(LEGACY_SIZE_TO_CANONICAL) as (keyof typeof LEGACY_SIZE_TO_CANONICAL)[]),
]);

/** A task `size` value as it appears on disk (canonical or legacy). */
export type TaskSize = z.infer<typeof TaskSizeSchema>;

/** Task priority (§4 dispatch ranking factor). */
export const TaskPrioritySchema = z.enum(['low', 'medium', 'high']);

/**
 * Maps any accepted {@link TaskSize} onto its canonical `xs`–`xl` form so the
 * `size ≥ threshold` promotion rule compares a single ordered scale.
 *
 * @param size - A canonical or legacy task size value.
 * @returns The equivalent {@link CanonicalSize}.
 */
export function normalizeSize(size: TaskSize): CanonicalSize {
  return size in LEGACY_SIZE_TO_CANONICAL
    ? LEGACY_SIZE_TO_CANONICAL[size as keyof typeof LEGACY_SIZE_TO_CANONICAL]
    : (size as CanonicalSize);
}

/**
 * A single decomposition task. Mirrors the shape emitted by `/spec:decompose`
 * and adds the optional `issue` / `parentIssue` fields (§8) — the only home for
 * the task→issue mapping. A promoted sub-issue records its canonical tracker id
 * in `issue`; `parentIssue` records the umbrella issue it hangs under.
 */
export const TaskSchema = z.object({
  /** Stable dotted task id, e.g. `"1.6"` (phase-scoped). */
  id: z.string(),
  /** Numeric phase index this task belongs to. */
  phase: z.number().int().nonnegative(),
  /** Human-readable phase name, e.g. `"P1 — Extract & thin"`. */
  phaseName: z.string(),
  /** One-line task subject (the checklist line / issue title). */
  subject: z.string(),
  /** Full task description (acceptance criteria, context). */
  description: z.string(),
  /** Present-continuous form for live status display, e.g. `"Extending …"`. */
  activeForm: z.string(),
  /** Task size on the canonical or legacy scale; gates sub-issue promotion. */
  size: TaskSizeSchema,
  /** Dispatch priority. */
  priority: TaskPrioritySchema,
  /** Task ids that must complete before this one. */
  dependencies: z.array(z.string()).default([]),
  /** Task ids that may run concurrently with this one. */
  parallelWith: z.array(z.string()).default([]),
  /**
   * Tracker id of this task's promoted sub-issue, if any (§8). The ONLY home
   * for the task→issue mapping. Absent for the common checklist-only task.
   */
  issue: z.string().optional(),
  /**
   * Tracker id of the umbrella issue this task's sub-issue hangs under (§8).
   * Set alongside {@link TaskSchema | `issue`} on promotion.
   */
  parentIssue: z.string().optional(),
});

/** A single decomposition task as parsed from `03-tasks.json`. */
export type Task = z.infer<typeof TaskSchema>;

/**
 * The full `specs/<slug>/03-tasks.json` document. `.strict()` is load-bearing:
 * it **rejects** a flat top-level `issues: […]` list (§8) — the task→issue map
 * lives per-task and nowhere else, so a sibling list can only reintroduce
 * drift.
 */
export const TasksFileSchema = z
  .object({
    /** Path to the source specification this decomposition derives from. */
    spec: z.string(),
    /** Spec slug (the `specs/<slug>/` directory name). */
    slug: z.string(),
    /** ISO-8601 timestamp the file was generated. */
    generatedAt: z.string(),
    /** Decomposition mode the file was generated under. */
    mode: z.enum(['full', 'incremental']),
    /** ISO-8601 timestamp of the last `/spec:decompose` run, or `null`. */
    lastDecomposeDate: z.string().nullable().default(null),
    /** The ordered decomposition tasks. */
    tasks: z.array(TaskSchema),
  })
  .strict();

/** A parsed `03-tasks.json` document. */
export type TasksFile = z.infer<typeof TasksFileSchema>;

/**
 * Whether a task is promotable to its own tracker sub-issue (§7.6, §8).
 *
 * Promotion fires **only** when the task's (normalized) size is at or above the
 * configured threshold (default `"xl"`); parent size does not additionally
 * gate. The vast majority of tasks fall below the threshold and stay checklist
 * lines.
 *
 * @param task - The task under evaluation.
 * @param threshold - The `decomposition.subIssueThreshold` (default `"xl"`).
 * @returns `true` if the task should be promoted to a sub-issue.
 */
export function isPromotableToSubIssue(
  task: Pick<Task, 'size'>,
  threshold: z.infer<typeof SubIssueThresholdSchema> = 'xl'
): boolean {
  const taskRank = CANONICAL_SIZE_ORDER.indexOf(normalizeSize(task.size));
  const thresholdRank = CANONICAL_SIZE_ORDER.indexOf(threshold);
  return taskRank >= thresholdRank;
}

/** Supported provenance trackers (mirrors {@link TrackerSchema}). */
export const ProvenanceTrackerSchema = z.enum(['linear']);

/**
 * PM-agnostic **provenance block** (§8) — a one-line frontmatter block that
 * names exactly ONE tracker "home" for a durable artifact (spec, ADR, or
 * research), replacing the legacy scalar `linear-issue:` field.
 *
 * The home is an `issue` (small spec / atomic artifact) **XOR** a `project`
 * (large spec) — never both, never neither. Back-links are bidirectional but
 * **ID-only** (stable, low-churn); typed relations (related/supersedes) go via
 * the adapter `link()`, not here. The block is general by design: it attaches
 * to specs, ADRs, and research alike.
 *
 * @example
 * ```yaml
 * # small spec / ADR / research — homed on an issue
 * provenance: { tracker: linear, issue: DOR-89 }
 * # large spec — homed on a project
 * provenance: { tracker: linear, project: proj_abc123 }
 * ```
 */
export const ProvenanceSchema = z
  .object({
    /** The project tracker this artifact is homed in. */
    tracker: ProvenanceTrackerSchema,
    /** Tracker issue id — the home for a small spec / ADR / research artifact. */
    issue: z.string().optional(),
    /** Tracker project id — the home for a large spec. */
    project: z.string().optional(),
  })
  .strict()
  .refine((p) => (p.issue === undefined) !== (p.project === undefined), {
    message: 'provenance must name exactly one of `issue` or `project`, never both or neither',
  });

/** A parsed provenance block naming exactly one tracker home. */
export type Provenance = z.infer<typeof ProvenanceSchema>;
