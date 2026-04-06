/**
 * @dorkos/marketplace — Claude Code-compatible `marketplace.json` schema.
 *
 * Defines the Zod schema for the top-level `marketplace.json` document that
 * Claude Code (and DorkOS) reads when browsing a marketplace. The schema is
 * the union of two disjoint groups of fields:
 *
 * 1. **Standard Claude Code fields** — the only fields Claude Code's parser
 *    is guaranteed to understand (`name`, `source`, `description`, etc.).
 * 2. **DorkOS extension fields** — optional metadata that enables browse and
 *    filter without cloning every package (`type`, `category`, `tags`, etc.).
 *
 * Both the per-entry schema and the top-level document schema use
 * `.passthrough()` so unknown fields survive a parse/serialize round-trip.
 * This is defensive — Claude Code's marketplace format may grow new fields
 * we have not yet modelled, and we should never silently strip them.
 *
 * This module is browser-safe — it imports `zod` only and has no Node.js
 * dependencies, so it can be consumed by `apps/client` and `apps/site`.
 *
 * @module @dorkos/marketplace/marketplace-json-schema
 */

import { z } from 'zod';
import { PackageTypeSchema } from './package-types.js';

/**
 * Standard Claude Code marketplace.json plugin entry fields.
 * These are the only fields Claude Code's parser is guaranteed to understand.
 */
const ClaudeCodeStandardEntrySchema = z.object({
  name: z.string().min(1),
  source: z.string().min(1),
  description: z.string().optional(),
  version: z.string().optional(),
  author: z.string().optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
});

/**
 * Optional DorkOS extension fields. Added to marketplace.json plugin entries
 * to enable browse/filter without cloning every package.
 *
 * If Claude Code's parser is strict and rejects unknown fields, these will
 * be moved to a companion `dorkos-catalog.json` file (Open Question #7).
 */
const DorkosExtensionFieldsSchema = z.object({
  /**
   * Package type — determines install flow. Optional; when absent, consumers
   * should treat the entry as a `plugin`. The schema does not apply a Zod
   * default so the absence of the field remains observable to downstream
   * code that wants to distinguish "explicit plugin" from "unspecified".
   */
  type: PackageTypeSchema.optional(),

  /** Browsing category (e.g., "frontend", "code-quality"). */
  category: z.string().max(64).optional(),

  /** Searchable tags. */
  tags: z.array(z.string().max(32)).max(20).optional(),

  /** Icon emoji or identifier. */
  icon: z.string().max(64).optional(),

  /** Layer/content categories. */
  layers: z
    .array(
      z.enum([
        'skills',
        'tasks',
        'commands',
        'hooks',
        'extensions',
        'adapters',
        'mcp-servers',
        'lsp-servers',
        'agents',
      ])
    )
    .optional(),

  /** Dependency declarations. */
  requires: z.array(z.string()).optional(),

  /** Whether to highlight in browse UI. */
  featured: z.boolean().optional(),

  /** Minimum DorkOS version. */
  dorkosMinVersion: z.string().optional(),
});

/**
 * A marketplace.json plugin entry. Combines standard CC fields with optional
 * DorkOS extension fields. Uses `passthrough()` so unknown fields are
 * preserved (defensive against future CC schema additions).
 */
export const MarketplaceJsonEntrySchema = ClaudeCodeStandardEntrySchema.merge(
  DorkosExtensionFieldsSchema
).passthrough();

/**
 * The full marketplace.json schema. Mirrors Claude Code's structure exactly:
 * `{ name: string, plugins: [...] }`.
 *
 * Uses `passthrough()` at the top level so additional CC marketplace metadata
 * (e.g., publisher info, version) is preserved.
 */
export const MarketplaceJsonSchema = z
  .object({
    name: z.string().min(1),
    plugins: z.array(MarketplaceJsonEntrySchema),
  })
  .passthrough();

/**
 * A single plugin entry within a `marketplace.json` document.
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
