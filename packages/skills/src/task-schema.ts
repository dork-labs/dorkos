import { z } from 'zod';
import { SkillFrontmatterSchema } from './schema.js';
import { DurationSchema } from './duration.js';

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
   * Agent permission mode during task execution.
   * - `acceptEdits`: agent can edit files with approval
   * - `bypassPermissions`: agent runs without approval gates
   */
  permissions: z.enum(['acceptEdits', 'bypassPermissions']).default('acceptEdits'),
});

export type TaskFrontmatter = z.infer<typeof TaskFrontmatterSchema>;
