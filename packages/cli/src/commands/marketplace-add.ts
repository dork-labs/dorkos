/**
 * CLI handler for `dorkos marketplace add <url> [--name=<n>]`.
 *
 * Posts a new marketplace source to the running DorkOS server. The source
 * URL is required; the friendly name is either supplied via `--name` or
 * derived from the URL's last path segment so common cases like
 * `https://github.com/dorkos/marketplace` produce a sensible default.
 *
 * Returns the intended exit code rather than calling `process.exit` so the
 * top-level dispatcher in `cli.ts` retains the single source of truth for
 * process termination.
 *
 * @module commands/marketplace-add
 */
import { parseArgs } from 'node:util';
import { ApiError, apiCall } from '../lib/api-client.js';

/** Parsed CLI arguments accepted by {@link runMarketplaceAdd}. */
export interface MarketplaceAddArgs {
  /** Source URL — Git repo or marketplace.json URL. */
  url: string;
  /** Optional friendly name. Derived from {@link url} when omitted. */
  name?: string;
}

/**
 * Successful response shape for `POST /api/marketplace/sources`. The server
 * returns the created {@link MarketplaceSource} verbatim.
 */
interface AddSourceResponseBody {
  name: string;
  source: string;
  enabled: boolean;
  addedAt: string;
}

/** One-line usage string surfaced in error messages. */
const USAGE_LINE = 'Usage: dorkos marketplace add <url> [--name <name>]';

/**
 * Parse the raw argv slice that follows `dorkos marketplace add`.
 *
 * @param rawArgs - The argv slice after `marketplace add` (i.e.
 *   `process.argv.slice(4)`).
 * @returns A typed {@link MarketplaceAddArgs} object.
 */
export function parseMarketplaceAddArgs(rawArgs: string[]): MarketplaceAddArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        name: { type: 'string' },
      },
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
      throw new Error(`Unknown option for 'marketplace add': ${option}\n${USAGE_LINE}`);
    }
    throw err;
  }

  const { values, positionals } = parsed;
  const url = positionals[0];
  if (!url) {
    throw new Error(`Missing required <url> argument.\n${USAGE_LINE}`);
  }

  return {
    url,
    name: typeof values.name === 'string' ? values.name : undefined,
  };
}

/**
 * Derive a default marketplace name from a source URL. Strips the
 * scheme/host and pulls the last non-empty path segment, lowercased and
 * with any trailing `.git` suffix removed. Falls back to `'marketplace'`
 * when no usable segment exists.
 *
 * Examples:
 *
 * - `https://github.com/dorkos/marketplace` → `marketplace`
 * - `https://github.com/anthropics/claude-plugins-official.git` →
 *   `claude-plugins-official`
 * - `https://example.com/` → `marketplace`
 *
 * Users can always override the derived name with `--name`.
 *
 * @param url - The source URL to derive a name from.
 * @returns A non-empty marketplace name.
 */
export function deriveDefaultName(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Not a parseable URL — treat the whole string as the path so SSH-style
    // git URLs (e.g. `git@github.com:dorkos/marketplace.git`) still work.
    pathname = url;
  }

  const segments = pathname
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return 'marketplace';
  }

  const last = segments[segments.length - 1].replace(/\.git$/i, '').toLowerCase();
  return last.length > 0 ? last : 'marketplace';
}

/**
 * Implements `dorkos marketplace add <url>`.
 *
 * @param args - Parsed marketplace-add arguments.
 * @returns The intended process exit code (`0` success, `1` error).
 */
export async function runMarketplaceAdd(args: MarketplaceAddArgs): Promise<number> {
  const name = args.name ?? deriveDefaultName(args.url);

  try {
    const created = await apiCall<AddSourceResponseBody>('POST', '/api/marketplace/sources', {
      name,
      source: args.url,
      enabled: true,
    });

    console.log(`Added marketplace '${created.name}' (${created.source}).`);
    return 0;
  } catch (err) {
    if (err instanceof ApiError) {
      // 409 = duplicate name. Surface a clearer hint than the raw server message.
      if (err.status === 409) {
        console.error(
          `Error: marketplace '${name}' already exists. Pass --name to choose another.`
        );
      } else {
        console.error(`Error: ${err.message}`);
      }
      return 1;
    }
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
