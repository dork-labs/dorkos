import { z } from 'zod';

// The harness vocabulary — HARNESS_IDS, HarnessIdSchema, HarnessId and
// HARNESS_LABELS — lives in @dorkos/shared/harness-schemas now (DOR-1890): the
// client needs HarnessId and HARNESS_LABELS to draw a chip row and cannot
// import this package, which is a Node filesystem engine. Importing and
// re-exporting here keeps every existing consumer of this module's four names
// working unchanged, and gives the rest of this module the local bindings it
// still needs, while leaving exactly one definition.
import {
  HARNESS_IDS,
  HarnessIdSchema,
  HARNESS_LABELS,
  type HarnessId,
} from '@dorkos/shared/harness-schemas';

export { HARNESS_IDS, HarnessIdSchema, HARNESS_LABELS };
export type { HarnessId };

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
 * The per-harness hook projection policy: whether that harness reads the
 * canonical hooks itself (`native`), gets a hooks file the engine writes
 * (`generate`), or gets nothing (`none`).
 *
 * Read by the planner since DOR-1858 (`plan/hooks-projection.ts`). An entry for a
 * harness the manifest does not enable, or for a `tool` that is not a harness at
 * all, does nothing and is named by `manifestNotices` (`manifest/notices.ts`).
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

/** One harness's hook projection policy, as the manifest states it. */
export type HookPolicy = z.infer<typeof HookPolicySchema>;

/** What a {@link HookPolicy} asks the engine to do with a harness's hooks. */
export type HookProjection = HookPolicy['projection'];

/**
 * The manifest keys that are accepted, ignored, and on their way out (DOR-1858).
 *
 * Each described something the engine has its own source for: plugin command
 * wrappers, `plan/command-formats.ts`, the scaffolded instruction pointers of
 * ADR-302, and a bundle concept the scanner replaced. None was ever read, and a
 * field that is validated but never read is a claim nobody checks.
 *
 * They stay in the schema so an existing manifest still parses — `.strict()`
 * would otherwise reject every repo that carries one, and `--enable` validates
 * with this schema before it writes a byte. `dorkos harness sync` names each one
 * it finds instead (`manifest/notices.ts`); that line is the whole migration,
 * because the manifest is a per-repo file nothing rewrites.
 */
export const RETIRED_MANIFEST_KEYS = [
  'skillWrappers',
  'commandMappings',
  'instructionProjections',
  'skillBundles',
] as const;

/**
 * The slimmed Harness Sync manifest (`.agents/harness.manifest.json`).
 *
 * Three keys carry meaning: `harnesses` (the enabled projection targets),
 * `claudeOnlySkills` (skills deliberately kept out of the canonical layer), and
 * `hookPolicies` (per-harness hook projection). Everything else the manifest
 * used to store is derived — the scanner reconstructs the skills from
 * `.agents/skills/*`, so a stale `sharedSkills` array is REJECTED by `.strict()`
 * rather than silently accepted (the drift guard).
 *
 * The four {@link RETIRED_MANIFEST_KEYS} are the deliberate exception: typed as
 * `unknown` so whatever a repo still has there parses and is ignored, rather
 * than failing a sync over a block nothing reads.
 */
export const HarnessManifestSchema = z
  .object({
    version: z.literal(1),
    /** Enabled projection targets. Claude Code is on by default. */
    harnesses: HarnessIdSchema.array().default(['claude-code']),
    claudeOnlySkills: ClaudeOnlySkillSchema.array().default([]),
    hookPolicies: HookPolicySchema.array().default([]),
    /** @deprecated Accepted and ignored — see {@link RETIRED_MANIFEST_KEYS}. */
    skillWrappers: z.unknown().optional(),
    /** @deprecated Accepted and ignored — see {@link RETIRED_MANIFEST_KEYS}. */
    commandMappings: z.unknown().optional(),
    /** @deprecated Accepted and ignored — see {@link RETIRED_MANIFEST_KEYS}. */
    instructionProjections: z.unknown().optional(),
    /** @deprecated Accepted and ignored — see {@link RETIRED_MANIFEST_KEYS}. */
    skillBundles: z.unknown().optional(),
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
