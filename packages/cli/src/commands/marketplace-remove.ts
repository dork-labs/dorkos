/**
 * CLI handler for `dorkos marketplace remove <name>`.
 *
 * Calls `DELETE /api/marketplace/sources/:name` and prints a one-line
 * confirmation. The endpoint returns 204 No Content on success and 404
 * when the named source is unknown.
 *
 * @module commands/marketplace-remove
 */
import { parseArgs } from 'node:util';
import { ApiError, apiCall } from '../lib/api-client.js';

/** Parsed CLI arguments accepted by {@link runMarketplaceRemove}. */
export interface MarketplaceRemoveArgs {
  /** Name of the marketplace source to remove. */
  name: string;
}

/** One-line usage string surfaced in error messages. */
const USAGE_LINE = 'Usage: dorkos marketplace remove <name>';

/**
 * Parse the raw argv slice that follows `dorkos marketplace remove`.
 *
 * @param rawArgs - The argv slice after `marketplace remove`.
 * @returns A typed {@link MarketplaceRemoveArgs} object.
 */
export function parseMarketplaceRemoveArgs(rawArgs: string[]): MarketplaceRemoveArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {},
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    if (
      err instanceof TypeError &&
      (err as NodeJS.ErrnoException).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
    ) {
      const match = err.message.match(/Unknown option '([^']+)'/);
      const option = match?.[1] ?? 'unknown';
      throw new Error(`Unknown option for 'marketplace remove': ${option}\n${USAGE_LINE}`);
    }
    throw err;
  }

  const name = parsed.positionals[0];
  if (!name) {
    throw new Error(`Missing required <name> argument.\n${USAGE_LINE}`);
  }

  return { name };
}

/**
 * Implements `dorkos marketplace remove <name>`.
 *
 * @param args - Parsed marketplace-remove arguments.
 * @returns The intended process exit code (`0` success, `1` error).
 */
export async function runMarketplaceRemove(args: MarketplaceRemoveArgs): Promise<number> {
  try {
    await apiCall<void>('DELETE', `/api/marketplace/sources/${encodeURIComponent(args.name)}`);
    console.log(`Removed marketplace '${args.name}'.`);
    return 0;
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 404) {
        console.error(`Error: marketplace '${args.name}' not found.`);
      } else {
        console.error(`Error: ${err.message}`);
      }
      return 1;
    }
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
