/**
 * @dorkos/marketplace — Claude Code marketplace.json schema (strict superset).
 *
 * This schema is a strict superset of Claude Code's `marketplace.json` format:
 *
 * 1. **Outbound invariant** — any `marketplace.json` produced against this
 *    schema, using only the CC-standard fields, must pass `claude plugin
 *    validate`. DorkOS-specific extensions do NOT live inline here; they
 *    live in the sidecar `.claude-plugin/dorkos.json` (see
 *    `dorkos-sidecar-schema.ts`). This is load-bearing — Claude Code's
 *    validator enforces `additionalProperties: false` on plugin entries,
 *    and any inline DorkOS keys would break validation (see
 *    `research/20260407_cc_validator_empirical_verify.md`).
 *
 * 2. **Inbound invariant** — any `marketplace.json` that passes `claude
 *    plugin validate` must parse cleanly via `MarketplaceJsonSchema`. The
 *    top-level document and plugin entries use `.passthrough()` so unknown
 *    CC fields (future additions) are preserved rather than stripped.
 *
 * The schema supports five source forms as a discriminated union:
 * relative-path (bare string starting with `./`), and the four object forms
 * `github`, `url`, `git-subdir`, and `npm`.
 *
 * Browser-safe — imports `zod` only. No Node.js dependencies.
 *
 * @module @dorkos/marketplace/marketplace-json-schema
 */

import { z } from 'zod';

/**
 * Marketplace names that CC reserves for official or impersonation-prevention
 * reasons. Any `marketplace.json` using one of these names is rejected at
 * parse time via the `.refine()` check on `MarketplaceJsonSchema.name`.
 *
 * Source: Claude Code marketplace docs (fetched 2026-04-07).
 */
export const RESERVED_MARKETPLACE_NAMES: ReadonlySet<string> = new Set([
  'claude-code-marketplace',
  'claude-code-plugins',
  'claude-plugins-official',
  'anthropic-marketplace',
  'anthropic-plugins',
  'agent-skills',
  'knowledge-work-plugins',
  'life-sciences',
]);

/**
 * Relative-path source form: a bare string starting with `./`. Resolved
 * against the marketplace root (optionally joined with `metadata.pluginRoot`).
 * Must not contain `..` traversals.
 */
const RelativePathSourceSchema = z
  .string()
  .regex(/^\.\//, 'Relative paths must start with "./"')
  .refine((s) => !s.includes('..'), 'Relative paths must not contain ".."');

/**
 * GitHub source form: `{ source: 'github', repo: 'owner/name', ref?, sha? }`.
 * The canonical clone URL is built as `https://github.com/<repo>.git`.
 */
const GithubSourceSchema = z.object({
  source: z.literal('github'),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'Must be owner/repo format'),
  ref: z.string().optional(),
  sha: z
    .string()
    .regex(/^[0-9a-f]{40}$/, 'SHA must be 40 lowercase hex characters')
    .optional(),
});

/**
 * Generic URL source form: `{ source: 'url', url, ref?, sha? }`. Supports
 * any git-cloneable URL including GitLab, Bitbucket, Azure DevOps, and
 * self-hosted Gitea/GitLab.
 */
const UrlSourceSchema = z.object({
  source: z.literal('url'),
  url: z.string().url(),
  ref: z.string().optional(),
  sha: z
    .string()
    .regex(/^[0-9a-f]{40}$/, 'SHA must be 40 lowercase hex characters')
    .optional(),
});

/**
 * Git subdirectory source form:
 * `{ source: 'git-subdir', url, path, ref?, sha? }`. Used for monorepos —
 * the install pipeline performs a sparse clone of `url` and materializes
 * only the `path` subdirectory.
 */
const GitSubdirSourceSchema = z.object({
  source: z.literal('git-subdir'),
  url: z.string(),
  path: z.string().min(1),
  ref: z.string().optional(),
  sha: z
    .string()
    .regex(/^[0-9a-f]{40}$/, 'SHA must be 40 lowercase hex characters')
    .optional(),
});

/**
 * npm source form: `{ source: 'npm', package, version?, registry? }`. Schema
 * validates shape only — the install pipeline in this spec leaves npm as a
 * structured deferred error (see spec marketplace-06-npm-sources).
 */
const NpmSourceSchema = z.object({
  source: z.literal('npm'),
  package: z.string().min(1),
  version: z.string().optional(),
  registry: z.string().url().optional(),
});

/**
 * Discriminated union of all five plugin source forms. The relative-path
 * form is a bare string; the other four are objects tagged with a `source`
 * literal discriminator.
 */
export const PluginSourceSchema = z.union([
  RelativePathSourceSchema,
  GithubSourceSchema,
  UrlSourceSchema,
  GitSubdirSourceSchema,
  NpmSourceSchema,
]);

/**
 * Author contact for a plugin entry. Object shape — CC accepts
 * `{ name: string, email?: string }`. Earlier DorkOS drafts modeled this
 * as a bare string; that was incompatible with CC's validator.
 */
export const AuthorSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
});

/**
 * Marketplace owner contact. Required at the top level of `marketplace.json`
 * per CC's validator. Same shape as `AuthorSchema`.
 */
export const OwnerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
});

/**
 * Top-level marketplace metadata. All fields are optional. `pluginRoot`
 * enables the same-repo monorepo pattern: when set, bare relative-path
 * sources are resolved against `<marketplaceRoot>/<pluginRoot>/<source>`.
 */
export const MetadataSchema = z.object({
  description: z.string().optional(),
  version: z.string().optional(),
  pluginRoot: z.string().optional(),
});

/**
 * A single plugin entry in `marketplace.json`. Contains only CC-standard
 * fields — DorkOS-specific extensions live in the sidecar `dorkos.json`
 * keyed by plugin `name`. The entry uses `.passthrough()` for defensive
 * forward-compatibility with new CC fields, but the authoritative
 * "strict" check lives in `cc-validator.ts`.
 */
export const MarketplaceJsonEntrySchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'Must be kebab-case'),
    source: PluginSourceSchema,
    description: z.string().optional(),
    version: z.string().optional(),
    author: AuthorSchema.optional(),
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
  .passthrough();

/**
 * The full `marketplace.json` document. Rejects reserved marketplace names
 * via `.refine()`. The top level uses `.passthrough()` so unknown top-level
 * CC fields survive a parse/serialize round-trip.
 */
export const MarketplaceJsonSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'Must be kebab-case')
      .refine(
        (name) => !RESERVED_MARKETPLACE_NAMES.has(name),
        'Reserved marketplace name — see CC reserved list'
      ),
    owner: OwnerSchema,
    metadata: MetadataSchema.optional(),
    plugins: z.array(MarketplaceJsonEntrySchema),
  })
  .passthrough();

/** A parsed plugin source (discriminated union of all five forms). */
export type PluginSource = z.infer<typeof PluginSourceSchema>;

/** Bare relative-path source form (a string starting with `./`). */
export type RelativePathSource = z.infer<typeof RelativePathSourceSchema>;

/** GitHub object source form. */
export type GithubSource = z.infer<typeof GithubSourceSchema>;

/** Generic URL object source form. */
export type UrlSource = z.infer<typeof UrlSourceSchema>;

/** Git subdirectory object source form. */
export type GitSubdirSource = z.infer<typeof GitSubdirSourceSchema>;

/** npm package object source form. */
export type NpmSource = z.infer<typeof NpmSourceSchema>;

/** Plugin author contact information. */
export type Author = z.infer<typeof AuthorSchema>;

/** Marketplace owner contact information. */
export type Owner = z.infer<typeof OwnerSchema>;

/** Top-level marketplace metadata. */
export type Metadata = z.infer<typeof MetadataSchema>;

/**
 * A parsed `marketplace.json` plugin entry.
 *
 * @see {@link MarketplaceJsonEntrySchema}
 */
export type MarketplaceJsonEntry = z.infer<typeof MarketplaceJsonEntrySchema>;

/**
 * A parsed `marketplace.json` document.
 *
 * @see {@link MarketplaceJsonSchema}
 */
export type MarketplaceJson = z.infer<typeof MarketplaceJsonSchema>;
