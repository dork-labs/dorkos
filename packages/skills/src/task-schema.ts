import { z } from 'zod';
import { SkillFrontmatterSchema } from './schema.js';
import { DurationSchema } from './duration.js';

/**
 * The permission modes a task file may declare in its `permissions:`
 * frontmatter — the same set a chat session may run under.
 *
 * DRIFT NOTE: an inlined mirror of `PermissionModeSchema`
 * (`packages/shared/src/schemas.ts`) by value. `@dorkos/shared` is on zod v4
 * and this package is still on v3, and nesting a v4 `ZodType` inside a v3
 * `z.object()` silently misbehaves rather than erroring (the same boundary
 * `ui-template.ts` documents), so the six values are inlined here instead of
 * composed. `__tests__/task-schema.test.ts` reads `PermissionModeSchema.options`
 * — a version-safe string-array read, never a cross-version schema composition
 * — and asserts the two sets are equal, so they cannot drift apart.
 *
 * `@dorkos/marketplace` re-exports this as `SHAPE_SCHEDULE_PERMISSION_MODES`
 * rather than keeping a third copy: what a Shape manifest may declare for a
 * schedule is exactly what the schedule's file may then carry, and a manifest
 * allowed to declare a mode the file cannot hold writes an unreadable file.
 */
export const TASK_PERMISSION_MODES = [
  'default',
  'plan',
  'acceptEdits',
  'dontAsk',
  'bypassPermissions',
  'auto',
] as const;

/**
 * Task frontmatter schema — a superset of the SKILL.md base.
 *
 * Adds scheduling, execution constraints, and display customization.
 * Fields that depend on installation context (agentId, cwd) are
 * intentionally excluded — they are derived from the file's location
 * on disk and stored in the DB only.
 */
export const TaskFrontmatterSchema = SkillFrontmatterSchema.extend({
  /** Human-readable display name. Falls back to humanized `name` if absent. */
  'display-name': z.string().optional(),

  /** Cron expression for scheduling. Absent means on-demand only. */
  cron: z.string().optional(),

  /** IANA timezone for cron evaluation. */
  timezone: z.string().default('UTC'),

  /** Whether the task is active. Disabled tasks are not scheduled. */
  enabled: z.boolean().default(true),

  /** Maximum execution time. Duration string: "5m", "1h", "30s", "2h30m". */
  'max-runtime': DurationSchema.optional(),

  /**
   * Agent permission mode during task execution. One of
   * {@link TASK_PERMISSION_MODES}.
   *
   * - `acceptEdits` (the default): file edits inside the workspace are accepted
   *   WITHOUT asking; every other tool still raises an approval.
   * - `bypassPermissions`: nothing asks. The run does whatever it decides to.
   * - `default`: every tool raises an approval.
   * - `plan`: read-only planning; nothing is written.
   * - `auto`, `dontAsk`: the remaining runtime modes, carried through as-is.
   *
   * A task run is unattended, so an approval nobody answers stalls the run —
   * the stricter modes trade throughput for safety, deliberately.
   */
  permissions: z.enum(TASK_PERMISSION_MODES).default('acceptEdits'),

  /**
   * Provenance marker: where this task came from. `shape` = stood up by a
   * Shape apply (DOR-355). Absent = user-created. The Shape re-bind flow only
   * re-targets tasks carrying this marker, so a user's own task can never be
   * hijacked by a name collision with a Shape schedule.
   */
  origin: z.enum(['shape']).optional(),

  /** The Shape (package name) that created this task. Present with `origin: shape`. */
  shape: z.string().optional(),
});

export type TaskFrontmatter = z.infer<typeof TaskFrontmatterSchema>;
