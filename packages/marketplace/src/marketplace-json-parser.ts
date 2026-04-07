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

import { type ZodIssue } from 'zod';
import { MarketplaceJsonSchema, type MarketplaceJson } from './marketplace-json-schema.js';
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
