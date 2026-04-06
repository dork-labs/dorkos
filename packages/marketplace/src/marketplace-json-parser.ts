/**
 * @dorkos/marketplace — Tolerant `marketplace.json` parser.
 *
 * Wraps {@link MarketplaceJsonSchema} with a string-in / discriminated-result-out
 * helper. Callers receive either a fully-typed `MarketplaceJson` or a
 * human-readable error message — they never have to handle thrown exceptions
 * from `JSON.parse` or Zod directly.
 *
 * Error message prefixes are stable and part of the public contract:
 *
 * - `Invalid JSON: ...` — the input was not valid JSON.
 * - `marketplace.json validation failed: ...` — the input parsed but did not
 *   match the schema. The trailing detail is a `;`-joined list of
 *   `path: message` pairs derived from the Zod issues.
 *
 * This module is browser-safe — it imports only `zod`-derived schemas and has
 * no Node.js dependencies, so it can be consumed by `apps/client` and
 * `apps/site` for client-side validation of remote marketplaces.
 *
 * @module @dorkos/marketplace/marketplace-json-parser
 */

import { MarketplaceJsonSchema, type MarketplaceJson } from './marketplace-json-schema.js';

/**
 * Discriminated result of {@link parseMarketplaceJson}.
 *
 * On success, `marketplace` is the fully-typed parsed document. On failure,
 * `error` is a human-readable string suitable for surfacing in CLI output or
 * UI toasts.
 */
export type ParseMarketplaceResult =
  | { ok: true; marketplace: MarketplaceJson }
  | { ok: false; error: string };

/**
 * Parse a marketplace.json string into a typed MarketplaceJson object.
 *
 * The parser is tolerant of:
 * - Standard Claude Code marketplaces (no DorkOS fields) — entries default to type=plugin
 * - DorkOS-extended marketplaces with type/category/tags/etc.
 * - Unknown fields at any level (preserved via passthrough)
 *
 * @param content - Raw JSON string from marketplace.json
 * @returns Parsed marketplace or error message
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
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: `marketplace.json validation failed: ${issues}` };
  }

  return { ok: true, marketplace: result.data };
}
