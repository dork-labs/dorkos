import { z } from 'zod';

/**
 * The agent harnesses Harness Sync can project to. Claude Code is the canonical
 * authoring harness; the rest are projection targets.
 */
export const HARNESS_IDS = [
  'claude-code',
  'codex',
  'cursor',
  'gemini',
  'copilot',
  'opencode',
] as const;

/** Zod schema for a single harness identifier (one of {@link HARNESS_IDS}). */
export const HarnessIdSchema = z.enum(HARNESS_IDS);

/** A supported agent harness identifier. */
export type HarnessId = z.infer<typeof HarnessIdSchema>;

/**
 * A skill intentionally kept Claude-only (not promoted to the canonical
 * `.agents/skills/` layer), with the reason it has not yet been made portable.
 * This is non-derivable exception data the scanner cannot reconstruct.
 */
const ClaudeOnlySkillSchema = z
  .object({
    name: z.string(),
    path: z.string(),
    reason: z.string(),
  })
  .strict();

/**
 * A renamed / tool-specific wrapper around a shared skill (e.g. a Codex wrapper
 * that re-names a Claude skill while preserving its guidance).
 */
const SkillWrapperSchema = z
  .object({
    target: HarnessIdSchema,
    name: z.string(),
    sharedSource: z.string(),
    targetPath: z.string(),
    reason: z.string(),
    status: z.string().optional(),
  })
  .strict();

/**
 * A mapping from a Claude slash command to the portable skill (or AGENTS.md
 * workflow) that carries its behavior to other harnesses. The slash-command
 * trigger stays Claude-only; the behavior travels as the mapped skill.
 */
const CommandMappingSchema = z
  .object({
    claudeCommand: z.string(),
    target: z.string(),
    strategy: z.string(),
    status: z.string(),
    notes: z.string().optional(),
  })
  .strict();

/**
 * A projection rule for an instruction source (e.g. `AGENTS.md`). Instructions
 * are scaffolded, never generated (ADR-302); each entry records which harnesses
 * read the source and how.
 */
const InstructionProjectionSchema = z
  .object({
    source: z.string(),
    status: z.string(),
    targets: z
      .object({
        tool: z.string(),
        mode: z.string(),
      })
      .strict()
      .array(),
    notes: z.string().optional(),
  })
  .strict();

/**
 * The per-harness hook projection policy: whether hooks are native to that
 * harness, generated from the canonical `.claude/settings.json`, or dropped.
 */
const HookPolicySchema = z
  .object({
    tool: z.string(),
    projection: z.enum(['native', 'generate', 'none']),
    configPath: z.string().optional(),
    status: z.string().optional(),
    notes: z.string().optional(),
  })
  .strict();

/**
 * A bundle of skills with a non-flat source root (e.g. a packaged plugin whose
 * skills live under `<bundle>/skills/`). The per-skill list is intentionally
 * NOT stored here — the scanner derives the individual skills from `sourceRoot`;
 * the manifest carries only the bundle-level projection policy.
 */
const SkillBundleSchema = z
  .object({
    name: z.string(),
    manifest: z.string().optional(),
    sourceRoot: z.string(),
    claudeProjectionRoot: z.string().optional(),
    notes: z.string().optional(),
  })
  .strict();

/**
 * The slimmed Harness Sync manifest (`.agents/harness.manifest.json`).
 *
 * It carries ONLY non-derivable policy + exceptions. The previously-stored
 * `sharedSkills` array and per-bundle `skills` lists are deliberately absent:
 * the scanner reconstructs them from `.agents/skills/*` and each bundle
 * `sourceRoot`. The schema is `.strict()`, so a stale manifest that still
 * carries a derivable `sharedSkills` array is REJECTED rather than silently
 * accepted (the drift guard).
 */
export const HarnessManifestSchema = z
  .object({
    version: z.literal(1),
    /** Enabled projection targets. Claude Code is on by default. */
    harnesses: HarnessIdSchema.array().default(['claude-code']),
    claudeOnlySkills: ClaudeOnlySkillSchema.array().default([]),
    skillWrappers: SkillWrapperSchema.array().default([]),
    commandMappings: CommandMappingSchema.array().default([]),
    instructionProjections: InstructionProjectionSchema.array().default([]),
    hookPolicies: HookPolicySchema.array().default([]),
    skillBundles: SkillBundleSchema.array().default([]),
  })
  .strict();

/** The validated, slimmed Harness Sync manifest shape. */
export type HarnessManifest = z.infer<typeof HarnessManifestSchema>;

/**
 * Parse + validate a raw `.agents/harness.manifest.json` value against
 * {@link HarnessManifestSchema}. Throws a {@link z.ZodError} on any violation,
 * including a stale derivable `sharedSkills` array (rejected by strict mode).
 *
 * @param raw - the parsed JSON value of `.agents/harness.manifest.json`.
 * @returns the validated manifest.
 */
export function parseHarnessManifest(raw: unknown): HarnessManifest {
  return HarnessManifestSchema.parse(raw);
}
