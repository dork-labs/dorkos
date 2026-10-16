/**
 * @dorkos/marketplace — `marketplace.json` and sidecar validators.
 *
 * Validates `marketplace.json` and `dorkos.json` sidecar documents for the CLI
 * validators. Re-exported from `@dorkos/marketplace/package-validator`, so
 * callers import them from there.
 *
 * @module @dorkos/marketplace/marketplace-json-validator
 */
import { parseMarketplaceJson, parseDorkosSidecar } from './marketplace-json-parser.js';
import { validateAgainstCcSchema } from './cc-validator.js';

/**
 * A structured marketplace validation finding. Unlike {@link ValidationIssue}
 * (which applies to a package on disk), these apply to a `marketplace.json`
 * or sidecar document and are used by the CLI validators
 * (`validate-marketplace`, `validate-remote`) to report DorkOS + CC schema
 * compliance.
 */
export interface MarketplaceValidationIssue {
  /** Severity — `error` fails validation, `warning` is informational. */
  level: 'error' | 'warning';
  /** Human-readable description of the issue. */
  message: string;
  /** Path into the JSON document where the issue was found. */
  path?: string[];
}

/**
 * Validate a `marketplace.json` document string against the DorkOS
 * (passthrough) schema. Returns an empty array when valid; returns one
 * error entry per Zod issue when invalid.
 *
 * @param raw - Raw JSON string from `marketplace.json`.
 * @returns Array of validation issues (empty when valid).
 */
export function validateMarketplaceJson(raw: string): MarketplaceValidationIssue[] {
  const result = parseMarketplaceJson(raw);
  if (result.ok) {
    return [];
  }
  return [{ level: 'error', message: result.error }];
}

/**
 * Validate a `marketplace.json` document string against the strict CC
 * schema (`cc-validator.ts`). Returns an empty array when valid; returns
 * one error entry per Zod issue when invalid. This is the *outbound
 * compatibility check*: if this function returns errors, the document
 * will fail `claude plugin validate`.
 *
 * @param raw - Raw JSON string from `marketplace.json`.
 * @returns Array of validation issues (empty when valid).
 */
export function validateMarketplaceJsonWithCcSchema(raw: string): MarketplaceValidationIssue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return [
      {
        level: 'error',
        message: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      },
    ];
  }

  const result = validateAgainstCcSchema(parsed);
  if (result.ok) {
    return [];
  }
  return result.errors.map((issue) => ({
    level: 'error' as const,
    message: issue.message,
    path: issue.path.map(String),
  }));
}

/**
 * Validate a `dorkos.json` sidecar document string. Returns an empty array
 * when valid; returns one error entry when invalid.
 *
 * @param raw - Raw JSON string from `.claude-plugin/dorkos.json`.
 * @returns Array of validation issues (empty when valid).
 */
export function validateDorkosSidecar(raw: string): MarketplaceValidationIssue[] {
  const result = parseDorkosSidecar(raw);
  if (result.ok) {
    return [];
  }
  return [{ level: 'error', message: result.error }];
}
