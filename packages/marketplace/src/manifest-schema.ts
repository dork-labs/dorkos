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

  /** Primary category for browse UI. */
  category: z.string().max(64).optional(),

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
          tone: z.number().int().min(1).max(5).optional(),
          autonomy: z.number().int().min(1).max(5).optional(),
          caution: z.number().int().min(1).max(5).optional(),
          communication: z.number().int().min(1).max(5).optional(),
          creativity: z.number().int().min(1).max(5).optional(),
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
 */
export const MarketplacePackageManifestSchema = z.discriminatedUnion('type', [
  PluginManifestSchema,
  AgentManifestSchema,
  SkillPackManifestSchema,
  AdapterManifestSchema,
]);

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
