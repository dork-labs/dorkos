import { z } from 'zod';
import { ScheduleBlockSchema } from './schedule-schema.js';
import { OptionalYamlBoolean } from './yaml-boolean.js';

export { readYamlBoolean } from './yaml-boolean.js';

/**
 * A frontmatter field that Claude Code accepts either as one string or as a
 * YAML list, and that DorkOS stores exactly as written.
 *
 * Splitting is the reader's job, not the schema's: `paths` splits on commas
 * and `arguments` on spaces, so a schema that normalized either one would have
 * to pick a separator and would get the other wrong.
 */
const StringOrStringList = z.union([z.string(), z.array(z.string())]);

/**
 * SKILL.md name field validation.
 *
 * Per the agentskills.io spec:
 * - 1-64 characters
 * - Lowercase alphanumeric and hyphens only
 * - Must not start or end with a hyphen
 * - Must not contain consecutive hyphens
 * - Must match the parent directory name (enforced at parse time, not in schema)
 */
export const SkillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    'Must be lowercase alphanumeric with hyphens, not starting/ending with hyphen'
  )
  .refine((s) => !s.includes('--'), 'Must not contain consecutive hyphens');

/**
 * Discriminator values for SKILL.md frontmatter.
 *
 * Per ADR-0220 (addendum) and ADR-0229, marketplace package authors SHOULD
 * declare `kind` explicitly so installers and validators do not need to fall
 * back to location-based or shape-based inference. User-authored files MAY
 * omit this field — inference rules apply (cron → task, commands/ → command,
 * otherwise → skill).
 *
 * The enum is intentionally narrow today; future kinds (e.g., `mcp-tool`,
 * `hook`) can be added without breaking existing files because the field
 * remains optional.
 *
 * @see decisions/0220-adopt-skill-md-open-standard.md
 * @see decisions/0229-skill-md-kind-discriminator-field.md
 */
export const SkillKindSchema = z.enum(['skill', 'task', 'command']);

/** Discriminator value for SKILL.md frontmatter. */
export type SkillKind = z.infer<typeof SkillKindSchema>;

/**
 * The one SKILL.md frontmatter schema.
 *
 * Three layers, in this order:
 *
 * 1. the agentskills.io open standard (`name`, `description`, `license`,
 *    `compatibility`, `metadata`, `allowed-tools`);
 * 2. Claude Code's extension fields, adopted **verbatim** — same names, same
 *    semantics, no DorkOS synonyms — so a skill already written for Claude
 *    Code needs no translation to work here (ADR `260823-200728`);
 * 3. the DorkOS `schedule:` block, whose presence makes the skill a scheduled
 *    task (ADR `260823-200724`).
 *
 * Every field past `name` and `description` is optional, and an unknown key is
 * stripped rather than rejected: one file is read by several tools, and a key
 * DorkOS does not know must never delete a person's skill from the product.
 *
 * @see https://agentskills.io/specification#skill-md-format
 * @see https://code.claude.com/docs/en/skills.md
 */
export const SkillFrontmatterSchema = z.object({
  /** Kebab-case identifier. Must match the parent directory name. */
  name: SkillNameSchema,

  /** What the skill does and when to use it. 1-1024 characters. */
  description: z.string().min(1).max(1024),

  /** License name or reference to a bundled license file. */
  license: z.string().optional(),

  /** Environment requirements (intended product, system packages, network access). */
  compatibility: z.string().max(500).optional(),

  /** Arbitrary key-value metadata for client-specific extensions. */
  metadata: z.record(z.string(), z.string()).optional(),

  /**
   * Tools the agent may use without asking, while this skill is active.
   *
   * Claude Code dialect: a space- or comma-separated string, or a YAML list,
   * stored exactly as written (see {@link StringOrStringList}). The list form
   * was accepted by Claude Code but rejected here until the schemas unified,
   * and rejecting it failed the whole file — a legal Claude Code skill simply
   * did not exist in DorkOS. `CommandRegistryService` already read both
   * shapes at runtime, so widening the schema only lets its validated path do
   * what its fallback path always did.
   */
  'allowed-tools': StringOrStringList.optional(),

  /**
   * Human-readable display name. Falls back to a humanized `name` if absent.
   *
   * A DorkOS extension that predates the unified schema — it lived on task
   * files first — and now belongs to every skill: a name good enough to show a
   * person is worth having whether or not the file happens to be scheduled.
   */
  'display-name': z.string().optional(),

  /**
   * Whether a person may invoke this skill directly (slash menus and other
   * human-facing pickers). Absent means yes — only an explicit `false` hides
   * it, leaving the skill model-only.
   *
   * Claude Code dialect, adopted verbatim: it honors the field natively for
   * its own surfaces, and DorkOS honors it on the surfaces it composes for
   * the other runtimes (`services/runtimes/codex/scan-skill-commands.ts`).
   * It lives on the base schema, not just `CommandFrontmatterSchema`, because
   * those surfaces parse authored skills with the base schema.
   */
  'user-invocable': OptionalYamlBoolean,

  /**
   * Whether the model must not invoke this skill on its own. `true` makes the
   * skill person-only: it stays out of the listings DorkOS hands to a model
   * (`services/core/mcp-resources/skill-resources.ts`), though an explicit
   * fetch by name still resolves — naming a skill is not auto-invocation.
   *
   * Claude Code dialect, adopted verbatim. Absent means the model may invoke.
   */
  'disable-model-invocation': OptionalYamlBoolean,

  /**
   * Tools removed from the agent's pool while this skill is active — the deny
   * half of `allowed-tools`.
   *
   * Claude Code dialect: a space- or comma-separated string, or a YAML list,
   * stored exactly as written (see {@link StringOrStringList}).
   */
  'disallowed-tools': StringOrStringList.optional(),

  /**
   * Glob patterns that limit when the model may load this skill on its own —
   * a skill about migrations stays out of the way until someone opens a
   * migration.
   *
   * Claude Code dialect: a comma-separated string or a YAML list, stored
   * exactly as written (see {@link StringOrStringList}).
   */
  paths: StringOrStringList.optional(),

  /**
   * Named positional arguments the skill body substitutes as `$name`.
   *
   * Claude Code dialect: a space-separated string or a YAML list, stored
   * exactly as written (see {@link StringOrStringList}).
   */
  arguments: StringOrStringList.optional(),

  /** Shell used for the skill's inline `` !`command` `` blocks. */
  shell: z.enum(['bash', 'powershell']).optional(),

  /** Execution context. `fork` runs the skill in an isolated subagent. */
  context: z.enum(['fork']).optional(),

  /** Which subagent type to fork, when `context: fork` is set. */
  agent: z.string().optional(),

  /**
   * Whether a forked skill runs in the background instead of being waited on.
   *
   * Only meaningful alongside `context: fork`; on its own it does nothing.
   * That pairing is deliberately not enforced here — a stray `background:` is
   * a no-op, and refusing the file over one would cost the author their whole
   * skill to fix nothing.
   */
  background: OptionalYamlBoolean,

  /** Model override while this skill is active. */
  model: z.string().optional(),

  /** Reasoning-effort override while this skill is active. */
  effort: z.enum(['low', 'medium', 'high', 'max']).optional(),

  /** Parameter hint shown during autocomplete (e.g., "[issue-number]"). */
  'argument-hint': z.string().optional(),

  /**
   * Presence makes this skill a **scheduled task**; absence leaves it a plain
   * skill. See {@link ScheduleBlockSchema} — including why cron *semantics*
   * are validated at the server seam and not here.
   */
  schedule: ScheduleBlockSchema.optional(),

  /**
   * Optional discriminator declaring whether this file is a skill, task, or
   * command. Marketplace packages SHOULD set this explicitly; user-authored
   * files MAY omit it and rely on location-based inference. See ADR-0229.
   */
  kind: SkillKindSchema.optional(),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

/**
 * Whether a person may invoke this skill directly — the question every
 * human-facing picker (a slash palette, a command menu) asks before showing
 * an entry. Absent means yes; only an explicit `user-invocable: false` hides
 * it, leaving the skill model-only.
 *
 * @param meta - Validated SKILL.md frontmatter.
 */
export function isUserInvocable(meta: Pick<SkillFrontmatter, 'user-invocable'>): boolean {
  return meta['user-invocable'] !== false;
}

/**
 * Whether the model may invoke this skill on its own — the question every
 * model-facing listing asks before advertising an entry. Absent means yes;
 * only an explicit `disable-model-invocation: true` withholds it, leaving the
 * skill person-only.
 *
 * This governs what a model is *told about*, not what it may read: an
 * explicit fetch of a named skill is a person's reference, not the model
 * inventing the invocation, so detail reads stay open.
 *
 * @param meta - Validated SKILL.md frontmatter.
 */
export function isModelInvocable(
  meta: Pick<SkillFrontmatter, 'disable-model-invocation'>
): boolean {
  return meta['disable-model-invocation'] !== true;
}
