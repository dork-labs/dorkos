/**
 * CLI handler for `dorkos package validate-marketplace <path>`.
 *
 * Validates a `marketplace.json` file against the schema from
 * `@dorkos/marketplace`. Used by the `dorkos-community` GitHub Actions
 * workflow on every PR to gate registry submissions.
 *
 * Returns the intended exit code rather than calling `process.exit` so the
 * top-level dispatcher in `cli.ts` retains the single source of truth for
 * process termination.
 *
 * Exit codes:
 *
 * - `0` — file is valid
 * - `1` — file missing or unreadable
 * - `2` — schema validation failed
 *
 * @module commands/package-validate-marketplace
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseMarketplaceJson } from '@dorkos/marketplace';

/** Parsed CLI arguments accepted by {@link runValidateMarketplace}. */
export interface ValidateMarketplaceArgs {
  /** Filesystem path (absolute or relative to `process.cwd()`) of the marketplace.json to validate. */
  path: string;
}

/** One-line usage string surfaced in error messages. */
const USAGE_LINE = 'Usage: dorkos package validate-marketplace <path>';

/**
 * Parse the raw argv slice that follows `dorkos package validate-marketplace`.
 *
 * Strict-positional only — no flags are accepted today. Throws an `Error`
 * (caught and formatted by the CLI dispatcher) when the positional path is
 * missing.
 *
 * @param rawArgs - The argv slice after `package validate-marketplace`.
 * @returns A typed {@link ValidateMarketplaceArgs} object.
 */
export function parseValidateMarketplaceArgs(rawArgs: string[]): ValidateMarketplaceArgs {
  const positional = rawArgs.filter((a) => !a.startsWith('-'));
  if (positional.length === 0) {
    throw new Error(`Missing required <path> argument.\n${USAGE_LINE}`);
  }
  return { path: positional[0] };
}

/**
 * Implements `dorkos package validate-marketplace <path>`.
 *
 * Reads the file at `args.path`, parses it via {@link parseMarketplaceJson},
 * and prints either an `OK` summary line on stdout (with the package count)
 * or an error description on stderr.
 *
 * @param args - Parsed CLI arguments.
 * @returns The intended process exit code.
 */
export async function runValidateMarketplace(args: ValidateMarketplaceArgs): Promise<number> {
  const absPath = path.resolve(process.cwd(), args.path);

  let content: string;
  try {
    content = await fs.readFile(absPath, 'utf8');
  } catch (err) {
    process.stderr.write(`Failed to read ${absPath}: ${(err as Error).message}\n`);
    return 1;
  }

  const result = parseMarketplaceJson(content);
  if (!result.ok) {
    process.stderr.write(`Validation failed: ${result.error}\n`);
    return 2;
  }

  process.stdout.write(`OK: ${absPath} (${result.marketplace.plugins.length} packages)\n`);
  return 0;
}
