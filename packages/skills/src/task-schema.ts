import { z } from 'zod';
import { SkillFrontmatterSchema } from './schema.js';
import { DurationSchema } from './duration.js';
import { TASK_PERMISSION_MODES } from './schedule-schema.js';
import type { ScheduleBlock } from './schedule-schema.js';

export { TASK_PERMISSION_MODES } from './schedule-schema.js';

/**
 * Legacy task frontmatter schema — scheduling fields at the TOP level.
 *
 * @deprecated Legacy top-level task fields; superseded by the `schedule:`
 * block on `SkillFrontmatterSchema`. This schema still describes every task
 * file on disk today and the live tasks pipeline still reads through it, so it
 * stays until the files themselves are rewritten. It is removed with the
 * migration wave (DOR-1486); use {@link legacyTaskToSchedule} to map a file
 * this schema parsed onto the block that replaces it.
 *
 * Fields that depend on installation context (agentId, cwd) are intentionally
 * excluded — they are derived from the file's location on disk and stored in
 * the DB only.
 */
export const TaskFrontmatterSchema = SkillFrontmatterSchema.extend({
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
   * {@link TASK_PERMISSION_MODES}; see `ScheduleBlockSchema.permissions` for
   * what each mode actually promises.
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

/**
 * @deprecated See {@link TaskFrontmatterSchema}.
 */
export type TaskFrontmatter = z.infer<typeof TaskFrontmatterSchema>;

/**
 * Map a legacy task file's top-level scheduling fields onto the `schedule:`
 * block that replaces them.
 *
 * Total and side-effect free — it never throws and never reads disk, so the
 * migration can call it on every candidate file before deciding what to write.
 * Three mappings are worth knowing:
 *
 * - **An empty `cron` becomes absent.** The legacy schema accepted `cron: ''`;
 *   the block does not, and both spellings mean the same thing — on-demand,
 *   nothing on a clock.
 * - **`display-name` does not move.** It lives on the base schema now and
 *   belongs to the skill, not to its schedule.
 * - **No `prompt` is produced.** Legacy tasks had no prompt override; the
 *   file's body was always what fired, and it still is.
 *
 * `origin`/`shape` carry over as the schedule's own provenance, including the
 * lopsided cases a hand-edited file can contain (a `shape:` with no `origin:`,
 * or the reverse) — the migration rewrites what it found rather than guessing
 * at what was meant.
 *
 * @param meta - Frontmatter validated by {@link TaskFrontmatterSchema}.
 * @returns The equivalent schedule block.
 */
export function legacyTaskToSchedule(meta: TaskFrontmatter): ScheduleBlock {
  return {
    ...(meta.cron ? { cron: meta.cron } : {}),
    timezone: meta.timezone,
    enabled: meta.enabled,
    ...(meta['max-runtime'] !== undefined ? { 'max-runtime': meta['max-runtime'] } : {}),
    permissions: meta.permissions,
    ...(meta.origin !== undefined ? { origin: meta.origin } : {}),
    ...(meta.shape !== undefined ? { shape: meta.shape } : {}),
  };
}
