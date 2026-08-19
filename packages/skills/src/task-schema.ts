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
   * **A mode id is a request, not a description.** What each one actually does
   * is declared by the runtime the task runs on
   * (`PermissionModeDescriptor.promise` in its capability profile), and the same
   * id can mean materially different things: `acceptEdits` on Claude Code edits
   * files and stops before a command, while on Codex it runs commands inside the
   * workspace too and cannot pause to ask at all. Read the runtime's profile —
   * or the Trust Dial, which renders it — for the sentence that is true for a
   * given task.
   *
   * What holds across runtimes:
   *
   * - `default`: the most careful setting the runtime offers.
   * - `acceptEdits` (the schema default): the agent changes files on its own.
   * - `plan`: read-only planning; nothing is written.
   * - `bypassPermissions`: nothing asks. The run does whatever it decides to.
   * - `auto`, `dontAsk`: the remaining runtime modes, carried through as-is.
   *
   * A task run is unattended, so nobody answers an approval it raises. It is
   * **refused** after `SESSIONS.INTERACTION_TIMEOUT_MS` (10 minutes) and the
   * turn carries on without it — it does not stall until `max-runtime`. A long
   * task under a strict mode therefore finishes, having quietly spent ten
   * minutes per ask and skipped the work behind each one. The stricter modes
   * trade throughput for safety, deliberately; budget `max-runtime` for the
   * asks you expect.
   *
   * A scheduled run is the ONE exception to parking: an interactive session
   * holds an unanswered prompt for four hours so a person can come back to it,
   * and a run nobody is watching has nobody to come back.
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
