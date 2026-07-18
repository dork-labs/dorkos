/**
 * @dorkos/marketplace — Package type taxonomy.
 *
 * Defines the five kinds of packages that can be distributed through a
 * DorkOS marketplace. The taxonomy is intentionally small and closed: every
 * package in the registry is exactly one of these types, and the type
 * determines lifecycle, validation rules, and installer behavior.
 *
 * This module is browser-safe — it imports `zod` only and has no Node.js
 * dependencies, so it can be consumed by `apps/client` and `apps/site`.
 *
 * @module @dorkos/marketplace/package-types
 */

import { z } from 'zod';

/**
 * Closed enumeration of package types supported by the DorkOS marketplace.
 *
 * The order of values is meaningful — it matches the canonical ordering used
 * across schemas, fixtures, and documentation, and downstream code may rely
 * on it (e.g. for stable test snapshots and UI dropdowns).
 *
 * Per ADR-0230 (extended by the Shapes spec, DOR-355), the five supported
 * types are:
 *
 * - `agent` — A reusable agent definition (system prompt, model preset,
 *   suggested tools, optional starter knowledge). Agent packages are pure
 *   DorkOS constructs and do **not** require a Claude Code plugin manifest.
 * - `plugin` — A Claude Code plugin (slash commands, hooks, settings).
 *   Distributed through the marketplace and installed via the Claude Code
 *   plugin loader.
 * - `skill-pack` — A bundle of one or more SKILL.md files (see the
 *   `@dorkos/skills` package). Provides reusable expertise that agents can
 *   load at runtime.
 * - `adapter` — An integration adapter that bridges DorkOS with an external
 *   system (relay transports, mesh discovery backends, runtime backends, etc.).
 * - `shape` — A "place": a bundle that composes existing packages, extensions,
 *   workspace chrome, suggested agents, schedules, and connections into a
 *   complete DorkOS experience you can switch into. Installing a Shape changes
 *   *what DorkOS is for you right now*; it holds agents by affinity, never
 *   ownership. The append-only newest member of the taxonomy.
 *
 * The order is append-only — `shape` is last so existing snapshots, fixtures,
 * and UI dropdowns keyed on the order are unchanged.
 */
export const PackageTypeSchema = z.enum(['agent', 'plugin', 'skill-pack', 'adapter', 'shape']);

/**
 * The set of valid package type identifiers.
 *
 * @see {@link PackageTypeSchema}
 */
export type PackageType = z.infer<typeof PackageTypeSchema>;

/**
 * Determine whether a package type requires an accompanying Claude Code
 * plugin manifest (`.claude-plugin/plugin.json`) when scaffolded or installed.
 *
 * Only `agent` packages are pure DorkOS constructs and ship without a plugin
 * manifest. All other types (`plugin`, `skill-pack`, `adapter`, `shape`) are
 * surfaced to Claude Code via a plugin manifest and therefore require one. A
 * Shape ships one even when it bundles only DorkOS-native content: it carries a
 * minimal `.claude-plugin/plugin.json` so any CC-visible content it does bundle
 * (skills/commands) is surfaced, consistent with `plugin`/`skill-pack`/`adapter`.
 *
 * @param type - The package type to test.
 * @returns `true` when a Claude Code plugin manifest is required for this
 *          package type, `false` otherwise.
 */
export function requiresClaudePlugin(type: PackageType): boolean {
  return type !== 'agent';
}
