/**
 * CLI handler for `dorkos marketplace refresh [<name>]`.
 *
 * Forces the running DorkOS server to re-fetch one or every configured
 * marketplace source. With no name argument, the command first lists every
 * source via `GET /api/marketplace/sources` and then issues a parallel
 * `Promise.allSettled` so a single failing source does not cancel the
 * batch — each result is reported on its own line.
 *
 * @module commands/marketplace-refresh
 */
import { parseArgs } from 'node:util';
import { ApiError, apiCall } from '../lib/api-client.js';

/** Parsed CLI arguments accepted by {@link runMarketplaceRefresh}. */
export interface MarketplaceRefreshArgs {
  /** Optional source name. When omitted, every configured source is refreshed. */
  name?: string;
}

/**
 * Response shape for `POST /api/marketplace/sources/:name/refresh`. The
 * server returns the parsed marketplace.json plus a server-generated
 * fetched-at timestamp. We pluck `plugins.length` for the success line —
 * the marketplace.json schema uses `plugins` as the entry array, but we
 * also accept the `packages` field name defensively in case a future
 * server revision renames it.
 */
interface RefreshResponseBody {
  marketplace: {
    name?: string;
    plugins?: unknown[];
    packages?: unknown[];
  };
  fetchedAt: string;
}

/** Marketplace source as returned by the server `/sources` endpoint. */
interface MarketplaceSource {
  name: string;
  source: string;
  enabled: boolean;
  addedAt?: string;
}

/** Response shape for `GET /api/marketplace/sources`. */
interface ListSourcesResponseBody {
  sources: MarketplaceSource[];
}

/** One-line usage string surfaced in error messages. */
const USAGE_LINE = 'Usage: dorkos marketplace refresh [<name>]';

/**
 * Parse the raw argv slice that follows `dorkos marketplace refresh`.
 *
 * @param rawArgs - The argv slice after `marketplace refresh`.
 * @returns A typed {@link MarketplaceRefreshArgs} object.
 */
export function parseMarketplaceRefreshArgs(rawArgs: string[]): MarketplaceRefreshArgs {
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
      throw new Error(`Unknown option for 'marketplace refresh': ${option}\n${USAGE_LINE}`);
    }
    throw err;
  }

  return {
    name: parsed.positionals[0],
  };
}

/**
 * Count packages reported by a refresh response. Prefers the canonical
 * `plugins` field on the marketplace.json schema, falling back to a
 * defensive `packages` field name in case future server revisions rename
 * the array.
 */
function countPackages(marketplace: RefreshResponseBody['marketplace']): number {
  if (Array.isArray(marketplace.plugins)) return marketplace.plugins.length;
  if (Array.isArray(marketplace.packages)) return marketplace.packages.length;
  return 0;
}

/**
 * Refresh a single marketplace source. Extracted so the all-sources path
 * can `Promise.allSettled` over many calls without having to inline the
 * fetch and console wiring.
 *
 * @param name - The marketplace source name to refresh.
 * @returns The package count reported by the server.
 */
async function refreshOne(name: string): Promise<number> {
  const result = await apiCall<RefreshResponseBody>(
    'POST',
    `/api/marketplace/sources/${encodeURIComponent(name)}/refresh`
  );
  return countPackages(result.marketplace);
}

/**
 * Format a single refresh outcome for display. Centralised so the success
 * and failure formats stay consistent across the single-source and
 * all-sources code paths.
 */
function formatSuccess(name: string, count: number): string {
  return `Refreshed ${name}: ${count} ${count === 1 ? 'package' : 'packages'}.`;
}

/**
 * Format an error encountered while refreshing one source. Pulls the
 * structured message out of {@link ApiError} when available so the user
 * sees the server's reason instead of an HTTP status code.
 */
function formatError(name: string, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return `Failed ${name}: not found.`;
    return `Failed ${name}: ${err.message}`;
  }
  return `Failed ${name}: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * Implements `dorkos marketplace refresh [<name>]`.
 *
 * @param args - Parsed marketplace-refresh arguments.
 * @returns The intended process exit code (`0` success, `1` if any source failed).
 */
export async function runMarketplaceRefresh(args: MarketplaceRefreshArgs): Promise<number> {
  // Single-source path: a focused error from the server should produce a
  // non-zero exit so scripts can detect the failure.
  if (args.name) {
    try {
      const count = await refreshOne(args.name);
      console.log(formatSuccess(args.name, count));
      return 0;
    } catch (err) {
      console.error(formatError(args.name, err));
      return 1;
    }
  }

  // All-sources path: list first, then refresh each in parallel. We use
  // Promise.allSettled so one bad source does not abort the batch — every
  // outcome is reported, and the exit code is non-zero only when at least
  // one source failed.
  let sources: MarketplaceSource[];
  try {
    const list = await apiCall<ListSourcesResponseBody>('GET', '/api/marketplace/sources');
    sources = list.sources;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  if (sources.length === 0) {
    console.log("No marketplaces configured. Run 'dorkos marketplace add <url>' to add one.");
    return 0;
  }

  const outcomes = await Promise.allSettled(sources.map((s) => refreshOne(s.name)));

  let failures = 0;
  outcomes.forEach((outcome, index) => {
    const sourceName = sources[index].name;
    if (outcome.status === 'fulfilled') {
      console.log(formatSuccess(sourceName, outcome.value));
    } else {
      failures += 1;
      console.error(formatError(sourceName, outcome.reason));
    }
  });

  return failures > 0 ? 1 : 0;
}
