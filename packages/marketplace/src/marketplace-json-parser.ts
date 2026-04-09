/**
 * @dorkos/marketplace — Tolerant `marketplace.json` and sidecar parser.
 *
 * Wraps the Zod schemas with string-in / discriminated-result-out helpers.
 * Callers receive either a fully-typed document or a human-readable error
 * message — they never have to handle thrown exceptions from `JSON.parse`
 * or Zod directly.
 *
 * Three exports:
 *
 * - `parseMarketplaceJson(raw)` — parses a `marketplace.json` document.
 * - `parseDorkosSidecar(raw)` — parses a `.claude-plugin/dorkos.json` sidecar.
 * - `parseMarketplaceWithSidecar(rawMarketplace, rawSidecar)` — high-level
 *   wrapper used by the site fetch layer and CLI validators. Parses both
 *   documents and returns merged entries plus an orphan list.
 *
 * Error message prefixes are stable and part of the public contract:
 *
 * - `Invalid JSON: ...` — the input was not valid JSON.
 * - `marketplace.json validation failed: ...` — the marketplace input
 *   parsed as JSON but did not match the schema.
 * - `dorkos.json validation failed: ...` — the sidecar input parsed as
 *   JSON but did not match the schema.
 *
 * Browser-safe — imports only Zod-derived schemas and has no Node.js
 * dependencies.
 *
 * @module @dorkos/marketplace/marketplace-json-parser
 */

import { z, type ZodIssue } from 'zod';
import {
  MarketplaceJsonSchema,
  MarketplaceJsonEntrySchema,
  MetadataSchema,
  OwnerSchema,
  type MarketplaceJson,
  type MarketplaceJsonEntry,
} from './marketplace-json-schema.js';
import { DorkosSidecarSchema, type DorkosSidecar } from './dorkos-sidecar-schema.js';
import { mergeMarketplace, type MergedMarketplaceEntry } from './merge-marketplace.js';

/**
 * Discriminated result of {@link parseMarketplaceJson}. On success,
 * `marketplace` is the fully-typed parsed document. On failure, `error`
 * is a human-readable string suitable for surfacing in CLI output or UI
 * toasts.
 */
export type ParseMarketplaceResult =
  | { ok: true; marketplace: MarketplaceJson }
  | { ok: false; error: string };

/** Discriminated result of {@link parseDorkosSidecar}. */
export type ParseDorkosSidecarResult =
  | { ok: true; sidecar: DorkosSidecar }
  | { ok: false; error: string };

/**
 * Discriminated result of {@link parseMarketplaceWithSidecar}. On success,
 * contains the parsed marketplace, the optional sidecar, the merged
 * entries, and any orphan sidecar plugin names.
 */
export type ParseMarketplaceWithSidecarResult =
  | {
      ok: true;
      marketplace: MarketplaceJson;
      sidecar: DorkosSidecar | null;
      merged: MergedMarketplaceEntry[];
      orphans: string[];
    }
  | { ok: false; error: string };

/**
 * Parse a `marketplace.json` string into a typed `MarketplaceJson` object.
 *
 * @param content - Raw JSON string from `marketplace.json`.
 * @returns Parsed marketplace or a human-readable error message.
 */
export function parseMarketplaceJson(content: string): ParseMarketplaceResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return {
      ok: false,
      error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const result = MarketplaceJsonSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: `marketplace.json validation failed: ${formatZodIssues(result.error.issues)}`,
    };
  }

  return { ok: true, marketplace: result.data };
}

/**
 * Parse a `dorkos.json` sidecar string into a typed `DorkosSidecar` object.
 *
 * @param content - Raw JSON string from `.claude-plugin/dorkos.json`.
 * @returns Parsed sidecar or a human-readable error message.
 */
export function parseDorkosSidecar(content: string): ParseDorkosSidecarResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return {
      ok: false,
      error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const result = DorkosSidecarSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: `dorkos.json validation failed: ${formatZodIssues(result.error.issues)}`,
    };
  }

  return { ok: true, sidecar: result.data };
}

/**
 * High-level wrapper used by the site fetch layer and CLI validators.
 * Parses both `marketplace.json` and (optionally) `dorkos.json`, merges
 * them, and returns the merged entries plus any orphan sidecar plugins.
 *
 * Pass `rawSidecar: null` when the sidecar is absent (404 on fetch, or
 * file does not exist locally). A missing sidecar is NOT an error —
 * merged entries simply have `dorkos: undefined`.
 *
 * @param rawMarketplace - Raw JSON string from `marketplace.json`.
 * @param rawSidecar - Raw JSON string from `dorkos.json`, or `null` if absent.
 * @returns Parsed+merged result or a human-readable error message.
 */
export function parseMarketplaceWithSidecar(
  rawMarketplace: string,
  rawSidecar: string | null
): ParseMarketplaceWithSidecarResult {
  const marketplaceResult = parseMarketplaceJson(rawMarketplace);
  if (!marketplaceResult.ok) {
    return { ok: false, error: marketplaceResult.error };
  }

  let sidecar: DorkosSidecar | null = null;
  if (rawSidecar !== null) {
    const sidecarResult = parseDorkosSidecar(rawSidecar);
    if (!sidecarResult.ok) {
      return { ok: false, error: sidecarResult.error };
    }
    sidecar = sidecarResult.sidecar;
  }

  const { entries, orphans } = mergeMarketplace(marketplaceResult.marketplace, sidecar);
  return {
    ok: true,
    marketplace: marketplaceResult.marketplace,
    sidecar,
    merged: entries,
    orphans,
  };
}

function formatZodIssues(issues: readonly ZodIssue[]): string {
  return issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
}

/**
 * A single plugin entry that could not be parsed by the lenient consumer.
 * Returned from {@link parseMarketplaceJsonLenient} so callers can log or
 * surface which entries were dropped without failing the whole document.
 */
export interface SkippedPlugin {
  /** Index within the source document's `plugins` array. */
  index: number;
  /** Best-effort name recovered from the raw entry, if any. */
  name?: string;
  /** Human-readable validation error message. */
  error: string;
}

/**
 * Discriminated result of {@link parseMarketplaceJsonLenient}. On success,
 * the parsed marketplace is returned alongside any individual plugin
 * entries that were skipped due to per-entry validation failures.
 */
export type ParseMarketplaceJsonLenientResult =
  | {
      ok: true;
      marketplace: MarketplaceJson;
      skippedPlugins: SkippedPlugin[];
    }
  | { ok: false; error: string };

/**
 * Lenient top-level `marketplace.json` schema used for CONSUMPTION of
 * upstream documents. Unlike {@link MarketplaceJsonSchema} (the authoring
 * schema), this variant:
 *
 * 1. Does NOT reject reserved marketplace names (e.g., `claude-plugins-official`) —
 *    the reserved list is a publishing policy, not a consumption policy. The
 *    real Anthropic marketplace is literally named `claude-plugins-official`,
 *    so consumers must be able to parse it.
 * 2. Accepts plugin names with broader characters (letters, digits, dots,
 *    hyphens) — matching what real upstream marketplaces ship today. The
 *    strict kebab-case authoring regex is enforced elsewhere.
 * 3. Models `plugins` as `z.unknown().array()` so individual entries can be
 *    re-validated one-by-one in the lenient parser, allowing a single bad
 *    entry to be skipped instead of failing the whole document.
 */
const LenientMarketplaceEnvelopeSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9.-]*$/, 'Must be kebab-case (letters, digits, dots, hyphens)'),
    owner: OwnerSchema,
    metadata: MetadataSchema.optional(),
    plugins: z.array(z.unknown()),
  })
  .passthrough();

/**
 * Lenient plugin entry schema used for per-entry re-validation in the
 * consumption path. Identical to {@link MarketplaceJsonEntrySchema} except
 * the name regex is relaxed to allow dots — real upstream marketplaces
 * ship entries like `wordpress.com` that would otherwise fail.
 */
const LenientPluginEntrySchema = MarketplaceJsonEntrySchema.extend({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9.-]*$/, 'Must be kebab-case (letters, digits, dots, hyphens)'),
});

/**
 * Parse a `marketplace.json` string for CONSUMPTION (i.e., displaying
 * upstream packages to the user), gracefully degrading on per-entry
 * failures.
 *
 * Behavior differs from {@link parseMarketplaceJson}:
 *
 * - Accepts reserved marketplace names (the reserved list applies only to
 *   publishing, not consuming).
 * - Accepts plugin names that include dots (e.g., `wordpress.com`), matching
 *   what real upstream marketplaces ship.
 * - A single invalid plugin entry is SKIPPED and surfaced in
 *   `skippedPlugins` rather than failing the whole document. Only a
 *   broken top-level envelope (missing `name`/`owner`/`plugins`) is fatal.
 *
 * Use this parser in code paths that fetch untrusted upstream content —
 * package fetcher, marketplace browse UI, install flows. Use the strict
 * {@link parseMarketplaceJson} for authoring paths (scaffolder, CLI
 * validators, local file:// publishing).
 *
 * @param content - Raw JSON string from a remote `marketplace.json`.
 * @returns Parsed marketplace + skipped entries, or a fatal envelope error.
 */
export function parseMarketplaceJsonLenient(content: string): ParseMarketplaceJsonLenientResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return {
      ok: false,
      error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const envelope = LenientMarketplaceEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    return {
      ok: false,
      error: `marketplace.json validation failed: ${formatZodIssues(envelope.error.issues)}`,
    };
  }

  const validPlugins: MarketplaceJsonEntry[] = [];
  const skippedPlugins: SkippedPlugin[] = [];

  envelope.data.plugins.forEach((rawEntry, index) => {
    const entryResult = LenientPluginEntrySchema.safeParse(rawEntry);
    if (entryResult.success) {
      validPlugins.push(entryResult.data as MarketplaceJsonEntry);
      return;
    }
    const recoveredName =
      rawEntry !== null && typeof rawEntry === 'object' && 'name' in rawEntry
        ? String((rawEntry as { name: unknown }).name)
        : undefined;
    skippedPlugins.push({
      index,
      name: recoveredName,
      error: formatZodIssues(entryResult.error.issues),
    });
  });

  // Reconstruct the typed document with only the valid plugins. The
  // authoring schema's name regex would reject some valid upstream names,
  // so we cast through `unknown` — the lenient envelope + per-entry
  // validation above already guarantees shape safety.
  const marketplace = {
    ...envelope.data,
    plugins: validPlugins,
  } as unknown as MarketplaceJson;

  return {
    ok: true,
    marketplace,
    skippedPlugins,
  };
}
