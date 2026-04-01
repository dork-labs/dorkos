import { z } from 'zod';
import { SkillFrontmatterSchema } from './schema.js';

/**
 * Command frontmatter schema — a superset of the SKILL.md base.
 *
 * Aligns with Claude Code's slash command extensions on top of the
 * agentskills.io base spec.
 */
export const CommandFrontmatterSchema = SkillFrontmatterSchema.extend({
  /** Parameter hint shown in autocomplete (e.g., "[issue-number]"). */
  'argument-hint': z.string().optional(),

  /** Prevent automatic loading by the model. Use for explicit-only commands. */
  'disable-model-invocation': z.boolean().optional(),

  /** Whether this command appears in the `/` menu. Default: true. */
  'user-invocable': z.boolean().default(true),

  /** Execution context. "fork" runs in an isolated subagent. */
  context: z.enum(['fork']).optional(),

  /** Subagent type when context is "fork". */
  agent: z.string().optional(),

  /** Model override for this command's execution. */
  model: z.string().optional(),

  /** Effort level override. */
  effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
});

export type CommandFrontmatter = z.infer<typeof CommandFrontmatterSchema>;
