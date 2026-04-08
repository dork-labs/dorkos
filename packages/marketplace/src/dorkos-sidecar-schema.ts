/**
 * @dorkos/marketplace — Sidecar schema for DorkOS marketplace extensions.
 *
 * The sidecar lives at `.claude-plugin/dorkos.json` next to `marketplace.json`.
 * It is indexed by plugin name and holds DorkOS-specific metadata that cannot
 * live inline in `marketplace.json` because Claude Code enforces
 * `additionalProperties: false` on plugin entries (see
 * `research/20260407_cc_validator_empirical_verify.md`).
 *
 * The sidecar is always optional — if it doesn't exist, merged entries have
 * `dorkos: undefined`. See `merge-marketplace.ts` for the drift handling
 * rules (orphan plugins, missing sidecars).
 *
 * Browser-safe — imports `zod` only. No Node.js dependencies.
 *
 * @module @dorkos/marketplace/dorkos-sidecar-schema
 */

import { z } from 'zod';

/**
 * Pricing metadata for a plugin. Always optional — plugins default to free
 * when the `pricing` field is absent. Added as a forward-compatibility hook
 * for future paid packages; the marketplace-05 spec lands this field but all
 * seed plugins are `{ model: 'free' }` at launch.
 */
export const PricingSchema = z.object({
  model: z.enum(['free', 'paid', 'freemium', 'byo-license']),
  priceUsd: z.number().nonnegative().optional(),
  billingPeriod: z.enum(['one-time', 'monthly', 'yearly']).optional(),
  trialDays: z.number().int().nonnegative().optional(),
});

/**
 * Per-plugin DorkOS extension metadata. All fields are optional so DorkOS
 * can treat plugins that lack a sidecar entry as default `plugin` type with
 * no extensions. The marketplace client and install pipeline both tolerate
 * a missing `dorkos` value on a merged entry.
 */
export const DorkosEntrySchema = z.object({
  /** DorkOS package type discriminator. Defaults to `plugin` when absent. */
  type: z.enum(['agent', 'plugin', 'skill-pack', 'adapter']).optional(),
  /** Layer/content categories the plugin contributes to. */
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
  /**
   * Dependency declarations, each of the form
   * `<type>:<name>[@<version-range>]`. The four dependency types mirror the
   * DorkOS package types.
   */
  requires: z
    .array(
      z.string().regex(/^(adapter|plugin|skill-pack|agent):[a-z][a-z0-9-]*([@][\w.~^>=<!*-]+)?$/)
    )
    .optional(),
  /** Whether to feature the plugin in browse UI. */
  featured: z.boolean().optional(),
  /** Icon emoji or identifier surfaced in browse UI. */
  icon: z.string().max(64).optional(),
  /** Minimum DorkOS semver version the plugin requires. */
  dorkosMinVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/)
    .optional(),
  /** Pricing metadata (free, paid, freemium, or bring-your-own-license). */
  pricing: PricingSchema.optional(),
});

/**
 * The full sidecar document. Plugin entries are indexed by plugin name,
 * matching the `name` field in `marketplace.json`. `schemaVersion` is a
 * strict literal `1` so future breaking changes require an explicit bump.
 */
export const DorkosSidecarSchema = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.literal(1),
  plugins: z.record(z.string(), DorkosEntrySchema),
});

/** Pricing metadata for a plugin. */
export type Pricing = z.infer<typeof PricingSchema>;

/** Per-plugin DorkOS extension metadata. */
export type DorkosEntry = z.infer<typeof DorkosEntrySchema>;

/** A parsed `dorkos.json` sidecar document. */
export type DorkosSidecar = z.infer<typeof DorkosSidecarSchema>;
