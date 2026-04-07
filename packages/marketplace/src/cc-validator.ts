/**
 * @dorkos/marketplace — Claude Code validator oracle (strict-mode port to Zod).
 *
 * This module is the **outbound compatibility oracle**: it tests whether a
 * DorkOS-produced `marketplace.json` will pass `claude plugin validate`. It
 * mirrors Claude Code's validator behavior using strict Zod schemas that
 * reject unknown fields via `.strict()` (the Zod equivalent of JSON Schema's
 * `additionalProperties: false`).
 *
 * This is a load-bearing mechanism for enforcing the sidecar strategy:
 * `MarketplaceJsonSchema` (in `marketplace-json-schema.ts`) uses
 * `.passthrough()` for defensive forward-compatibility, but this schema
 * uses `.strict()` to REJECT any `marketplace.json` that has DorkOS
 * extension fields inline on plugin entries. Consumers that need to prove
 * outbound CC compatibility (the CLI validators, CI gates) use this file.
 *
 * **Sync direction invariant** (load-bearing): `cc-validator.ts` MUST NOT
 * be stricter than Claude Code's actual CLI behavior for any field CC
 * currently accepts. Looser-than-CC is acceptable (we may accept valid CC
 * marketplaces that the unofficial reference rejects); stricter-than-CC is
 * a regression that breaks the bidirectional compatibility invariant and
 * must be fixed immediately.
 *
 * **Reference source**: `hesreallyhim/claude-code-json-schema`
 * (community-maintained reverse-engineered JSON Schema). The weekly
 * `cc-schema-sync` cron (`.github/workflows/cc-schema-sync.yml`) diffs
 * this port against the upstream reference and opens a PR on drift.
 *
 * Browser-safe — imports `zod` only.
 *
 * @module @dorkos/marketplace/cc-validator
 */

import { z, type ZodIssue } from 'zod';
import { PluginSourceSchema, RESERVED_MARKETPLACE_NAMES } from './marketplace-json-schema.js';

/**
 * The set of plugin source forms CC accepts. Identical to DorkOS's own
 * `PluginSourceSchema` — re-exported here so the CC validator module is
 * self-contained and its sync invariant can be audited in one place.
 */
export const CcSourceSchema = PluginSourceSchema;

/**
 * CC-compatible author schema. Object shape with required `name` and
 * optional `email`. Matches DorkOS's `AuthorSchema` exactly.
 */
const CcAuthorSchema = z
  .object({
    name: z.string().min(1),
    email: z.string().email().optional(),
  })
  .strict();

/**
 * CC-compatible owner schema (top-level marketplace owner). Object shape
 * with required `name` and optional `email`.
 */
const CcOwnerSchema = z
  .object({
    name: z.string().min(1),
    email: z.string().email().optional(),
  })
  .strict();

/**
 * CC-compatible metadata schema (top-level marketplace metadata). All
 * fields optional. `pluginRoot` is the monorepo convenience that lets
 * relative-path entries elide the `./plugins/` prefix.
 */
const CcMetadataSchema = z
  .object({
    description: z.string().optional(),
    version: z.string().optional(),
    pluginRoot: z.string().optional(),
  })
  .strict();

/**
 * CC-compatible plugin entry schema. Uses `.strict()` to reject unknown
 * keys — this is the mechanism that enforces the sidecar strategy. Any
 * DorkOS-specific extension field appearing inline will fail parse with
 * a `Unrecognized key` error matching CC's own validator output.
 *
 * CC component fields (`commands`, `agents`, `hooks`, `mcpServers`,
 * `lspServers`) are modeled as `z.unknown().optional()` — DorkOS does not
 * interpret them, but CC does, so they must be allowed on the plugin
 * entry for strict mode to pass.
 */
export const CcMarketplaceJsonEntrySchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'Must be kebab-case'),
    source: CcSourceSchema,
    description: z.string().optional(),
    version: z.string().optional(),
    author: CcAuthorSchema.optional(),
    homepage: z.string().url().optional(),
    repository: z.string().url().optional(),
    license: z.string().max(64).optional(),
    keywords: z.array(z.string()).max(50).optional(),
    category: z.string().max(64).optional(),
    tags: z.array(z.string().max(32)).max(20).optional(),
    strict: z.boolean().optional(),
    commands: z.unknown().optional(),
    agents: z.unknown().optional(),
    hooks: z.unknown().optional(),
    mcpServers: z.unknown().optional(),
    lspServers: z.unknown().optional(),
  })
  .strict();

/**
 * CC-compatible top-level `marketplace.json` schema. Rejects reserved
 * marketplace names and unknown top-level keys.
 */
export const CcMarketplaceJsonSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'Must be kebab-case')
      .refine(
        (name) => !RESERVED_MARKETPLACE_NAMES.has(name),
        'Reserved marketplace name — see CC reserved list'
      ),
    owner: CcOwnerSchema,
    metadata: CcMetadataSchema.optional(),
    plugins: z.array(CcMarketplaceJsonEntrySchema),
  })
  .strict();

/**
 * Validate an unknown value against the strict CC marketplace schema.
 * Returns a discriminated result so callers can distinguish "valid" from
 * "invalid with a list of issues" without handling thrown exceptions.
 *
 * Used by the CLI validators (`validate-marketplace`, `validate-remote`)
 * and CI gates that want to assert outbound CC compatibility explicitly.
 *
 * @param raw - Parsed JSON value (output of `JSON.parse`).
 * @returns Discriminated result with either success or the list of Zod issues.
 */
export function validateAgainstCcSchema(
  raw: unknown
): { ok: true } | { ok: false; errors: ZodIssue[] } {
  const result = CcMarketplaceJsonSchema.safeParse(raw);
  if (result.success) {
    return { ok: true };
  }
  return { ok: false, errors: result.error.issues };
}
