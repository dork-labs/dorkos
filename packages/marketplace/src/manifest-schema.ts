/**
 * @dorkos/marketplace — Marketplace package manifest schema.
 *
 * Defines the canonical Zod schema for `.dork/manifest.json`, the source of
 * truth for a DorkOS marketplace package's identity, type, dependencies, and
 * metadata. The top-level schema is a discriminated union over `type` so that
 * type-specific fields (e.g. `adapterType` for adapters, `agentDefaults` for
 * agent templates) are validated in a single pass.
 *
 * This module is browser-safe — it imports only `zod`, `@dorkos/skills/schema`,
 * and the local `package-types` module, with no Node.js dependencies. It can
 * therefore be consumed by `apps/client` and `apps/site`.
 *
 * @module @dorkos/marketplace/manifest-schema
 */

import { z } from 'zod';
import { SkillNameSchema } from '@dorkos/skills/schema';
import { PackageTypeSchema } from './package-types.js';
import { MarketplaceCategorySchema } from './categories.js';

/**
 * Semver version string. Loose validation — full semver parsing is the
 * installer's responsibility.
 */
const SemverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/, 'Must be a valid semver string');

/**
 * A dependency declaration. Format: `<type>:<name>` or `<type>:<name>@<version>`.
 *
 * @example
 *   "adapter:slack"
 *   "adapter:slack@^1.0.0"
 *   "plugin:linear-integration"
 */
const DependencyDeclarationSchema = z
  .string()
  .regex(
    /^(adapter|plugin|skill-pack|agent):[a-z][a-z0-9-]*([@][\w.~^>=<!*-]+)?$/,
    'Must be of the form <type>:<name> or <type>:<name>@<version>'
  );

/**
 * Layer declarations describe what kinds of content a package contains.
 * Used by the marketplace UI to filter and display package capabilities.
 */
const PackageLayerSchema = z.enum([
  'skills',
  'tasks',
  'commands',
  'hooks',
  'extensions',
  'adapters',
  'mcp-servers',
  'lsp-servers',
  'agents',
]);

/**
 * Common fields shared by all package types.
 */
const BasePackageManifestSchema = z.object({
  /** Schema version. Currently 1. */
  schemaVersion: z.literal(1).default(1),

  /** Package identifier. Kebab-case, must match the directory name. */
  name: SkillNameSchema,

  /** Semver version string. */
  version: SemverSchema,

  /** Package type — determines install flow and validation rules. */
  type: PackageTypeSchema,

  /** Short description shown in marketplace browse UI. 1-1024 chars. */
  description: z.string().min(1).max(1024),

  /** Optional human-readable display name. Falls back to humanized `name`. */
  displayName: z.string().max(128).optional(),

  /** Author name or organization. */
  author: z.string().max(256).optional(),

  /** SPDX license identifier or "UNLICENSED". */
  license: z.string().max(64).optional(),

  /** Repository URL (typically a git URL). */
  repository: z.string().url().optional(),

  /** Homepage URL. */
  homepage: z.string().url().optional(),

  /** Searchable tags. */
  tags: z.array(z.string().max(32)).max(20).default([]),

  /**
   * Primary category. Kept CC-interop and deliberately LENIENT (`z.string()`,
   * not the enum): installed packages' on-disk manifests may carry legacy
   * free-string categories, and the harness safeParses them
   * (`packages/harness/src/sources/installed.ts` `readPluginManifest` returns
   * `undefined` on a failed parse, which would make every legacy-categorized
   * installed package invisible to Harness projection — the DOR-264 regression
   * class). Coherence with the enum-typed `categories[0]` provides the
   * effective constraint for newly-authored packages.
   */
  category: z.string().max(64).optional(),

  /**
   * Controlled multi-membership categories (ADR-0236). Enum-constrained,
   * deduplicated, max 4. The first element is the primary category and must
   * equal the singular `category` when both are present (coherence refine
   * below). Rides the sidecar for CC-authored packages; carried inline here
   * in the DorkOS author source (`.dork/manifest.json`).
   */
  categories: z
    .array(MarketplaceCategorySchema)
    .max(4)
    .refine((c) => new Set(c).size === c.length, 'categories must be unique')
    .optional(),

  /** Icon emoji or icon identifier (e.g., "🔍" or "package"). */
  icon: z.string().max(64).optional(),

  /** Minimum DorkOS version required (semver). */
  minDorkosVersion: SemverSchema.optional(),

  /** Layers (content categories) this package contributes. Informational. */
  layers: z.array(PackageLayerSchema).default([]),

  /** Other packages this one depends on. */
  requires: z.array(DependencyDeclarationSchema).default([]),

  /** Whether to highlight in marketplace browse UI (registry sets this, not the package). */
  featured: z.boolean().optional(),
});

/**
 * Plugin-specific manifest fields.
 */
const PluginManifestSchema = BasePackageManifestSchema.extend({
  type: z.literal('plugin'),
  /** Optional list of extension IDs bundled in this package. */
  extensions: z.array(z.string()).default([]),
});

/**
 * Agent (template) -specific manifest fields.
 */
const AgentManifestSchema = BasePackageManifestSchema.extend({
  type: z.literal('agent'),
  /** Default agent identity values applied during creation. */
  agentDefaults: z
    .object({
      persona: z.string().max(4000).optional(),
      capabilities: z.array(z.string()).default([]),
      traits: z
        .object({
          verbosity: z.number().int().min(1).max(5).optional(),
          autonomy: z.number().int().min(1).max(5).optional(),
          chaos: z.number().int().min(1).max(5).optional(),
          creativity: z.number().int().min(1).max(5).optional(),
          humor: z.number().int().min(1).max(5).optional(),
          spice: z.number().int().min(1).max(5).optional(),
        })
        .optional(),
    })
    .optional(),
});

/**
 * Skill-pack-specific manifest fields. (Currently no extra fields beyond base.)
 */
const SkillPackManifestSchema = BasePackageManifestSchema.extend({
  type: z.literal('skill-pack'),
});

/**
 * Adapter-specific manifest fields.
 */
const AdapterManifestSchema = BasePackageManifestSchema.extend({
  type: z.literal('adapter'),
  /** Adapter type identifier (e.g., "discord", "slack"). */
  adapterType: z.string().min(1).max(64),
});

/**
 * Discriminated union over package type. Validates type-specific fields
 * based on the `type` discriminator.
 *
 * The primary-category coherence refine (`category === categories[0]` when both
 * are present) wraps the union: Zod cannot `.refine` a `discriminatedUnion`
 * member and keep the discriminator, so the check sits at the top level. The
 * inferred {@link MarketplacePackageManifest} type is unaffected — a `.refine`
 * on a discriminated union preserves the union, so consumers still narrow on
 * `manifest.type`. Because `categories[0]` is enum-typed, coherent manifests
 * are effectively enum-constrained on their primary category, while legacy
 * singular-only manifests (no `categories`) still parse (the singular field
 * stays lenient).
 */
export const MarketplacePackageManifestSchema = z
  .discriminatedUnion('type', [
    PluginManifestSchema,
    AgentManifestSchema,
    SkillPackManifestSchema,
    AdapterManifestSchema,
  ])
  .refine((m) => !(m.category && m.categories?.length) || m.category === m.categories[0], {
    message: 'category must equal categories[0] when both are present',
    path: ['category'],
  });

/**
 * The package `name` field schema (kebab-case slug, 1-64 chars), exported for
 * consumers that must validate a package name outside a full manifest parse —
 * e.g. the harness scanner's `.claude-plugin/plugin.json` fallback, where the
 * name is interpolated into filesystem paths and must never be an arbitrary
 * string.
 */
export const PackageNameSchema = SkillNameSchema;

/**
 * Validated marketplace package manifest. Discriminated union — narrow on
 * `manifest.type` to access type-specific fields.
 */
export type MarketplacePackageManifest = z.infer<typeof MarketplacePackageManifestSchema>;

/**
 * Validated plugin package manifest variant.
 */
export type PluginPackageManifest = z.infer<typeof PluginManifestSchema>;

/**
 * Validated agent package manifest variant.
 */
export type AgentPackageManifest = z.infer<typeof AgentManifestSchema>;

/**
 * Validated skill-pack package manifest variant.
 */
export type SkillPackPackageManifest = z.infer<typeof SkillPackManifestSchema>;

/**
 * Validated adapter package manifest variant.
 */
export type AdapterPackageManifest = z.infer<typeof AdapterManifestSchema>;
