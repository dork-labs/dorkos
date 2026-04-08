/**
 * CLI handlers for `dorkos cache list/prune/clear`.
 *
 * The three subcommands live in a single file because each is a thin
 * wrapper around a matching `/api/marketplace/cache*` endpoint and their
 * arg parsers are small enough that extracting them into separate modules
 * would add more ceremony than clarity.
 *
 * - `cache list` → `GET /api/marketplace/cache`
 * - `cache prune` → `POST /api/marketplace/cache/prune`
 * - `cache clear` → `DELETE /api/marketplace/cache`
 *
 * All three return a numeric exit code rather than calling `process.exit`
 * directly so `cli.ts` stays the single source of truth for termination.
 *
 * @module commands/cache-commands
 */
import { parseArgs } from 'node:util';
import { ApiError, apiCall } from '../lib/api-client.js';
import { confirm } from '../lib/confirm-prompt.js';

/** One-line usage string surfaced in error messages for `cache list`. */
const LIST_USAGE = 'Usage: dorkos cache list';

/** One-line usage string surfaced in error messages for `cache prune`. */
const PRUNE_USAGE = 'Usage: dorkos cache prune [--keep-last-n <N>]';

/** One-line usage string surfaced in error messages for `cache clear`. */
const CLEAR_USAGE = 'Usage: dorkos cache clear [-y|--yes]';

/** Response shape for `GET /api/marketplace/cache`. */
interface CacheStatusResponse {
  marketplaces: number;
  packages: number;
  totalSizeBytes: number;
}

/** Response shape for `POST /api/marketplace/cache/prune`. */
interface PruneResponse {
  removed: Array<{
    packageName: string;
    commitSha: string;
    path: string;
    cachedAt: string;
  }>;
  freedBytes: number;
}

/** Parsed CLI arguments for `cache prune`. */
export interface CachePruneArgs {
  /** Optional `--keep-last-n <N>` cutoff. Defaults to the server's default (1). */
  keepLastN?: number;
}

/** Parsed CLI arguments for `cache clear`. */
export interface CacheClearArgs {
  /** When true, skip the interactive confirmation prompt. */
  yes: boolean;
}

/**
 * Format a byte count as a right-justified human-readable string.
 *
 * Picks the largest unit where the value would render with at least one
 * whole digit and formats with two decimal places (stripping trailing
 * zeros) so common sizes render cleanly: `512 B`, `4.5 KB`, `47 MB`,
 * `1.25 GB`. Extracted as a pure helper so tests can exercise the
 * formatting edges without mocking the server.
 *
 * @param bytes - Non-negative byte count.
 * @returns A string like `47 MB` or `512 B`.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i];
  }
  const rounded = Math.round(value * 100) / 100;
  // Drop trailing zeros so `47.00 MB` becomes `47 MB`.
  const formatted = Number.isInteger(rounded) ? String(rounded) : rounded.toString();
  return `${formatted} ${unit}`;
}

/**
 * Parse the raw argv slice that follows `dorkos cache list`. The
 * subcommand takes no arguments, so we only check that no unknown options
 * were passed.
 *
 * @param rawArgs - The argv slice after `cache list`.
 */
export function parseCacheListArgs(rawArgs: string[]): void {
  try {
    parseArgs({
      args: rawArgs,
      options: {},
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    if (
      err instanceof TypeError &&
      (err as NodeJS.ErrnoException).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
    ) {
      const match = err.message.match(/Unknown option '([^']+)'/);
      const option = match?.[1] ?? 'unknown';
      throw new Error(`Unknown option for 'cache list': ${option}\n${LIST_USAGE}`);
    }
    throw err;
  }
}

/**
 * Parse the raw argv slice that follows `dorkos cache prune`. Supports
 * an optional `--keep-last-n <N>` flag; omitting it defers to the
 * server-side default (keep one entry per package name).
 *
 * @param rawArgs - The argv slice after `cache prune`.
 * @returns A typed {@link CachePruneArgs} object.
 */
export function parseCachePruneArgs(rawArgs: string[]): CachePruneArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        'keep-last-n': { type: 'string' },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    if (
      err instanceof TypeError &&
      (err as NodeJS.ErrnoException).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
    ) {
      const match = err.message.match(/Unknown option '([^']+)'/);
      const option = match?.[1] ?? 'unknown';
      throw new Error(`Unknown option for 'cache prune': ${option}\n${PRUNE_USAGE}`);
    }
    throw err;
  }

  const raw = parsed.values['keep-last-n'];
  if (raw === undefined) {
    return {};
  }
  const parsedNumber = Number(raw);
  if (!Number.isInteger(parsedNumber) || parsedNumber < 0) {
    throw new Error(
      `Invalid value for --keep-last-n: '${String(raw)}' (expected a non-negative integer).\n${PRUNE_USAGE}`
    );
  }
  return { keepLastN: parsedNumber };
}

/**
 * Parse the raw argv slice that follows `dorkos cache clear`. Supports
 * `-y`/`--yes` to skip the interactive confirmation prompt.
 *
 * @param rawArgs - The argv slice after `cache clear`.
 * @returns A typed {@link CacheClearArgs} object.
 */
export function parseCacheClearArgs(rawArgs: string[]): CacheClearArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        yes: { type: 'boolean', short: 'y', default: false },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    if (
      err instanceof TypeError &&
      (err as NodeJS.ErrnoException).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
    ) {
      const match = err.message.match(/Unknown option '([^']+)'/);
      const option = match?.[1] ?? 'unknown';
      throw new Error(`Unknown option for 'cache clear': ${option}\n${CLEAR_USAGE}`);
    }
    throw err;
  }

  return { yes: Boolean(parsed.values.yes) };
}

/**
 * Render a cache status summary as a three-line right-aligned block.
 * Extracted as a pure helper so tests can assert on the exact layout
 * without mocking I/O.
 *
 * @param status - Cache status returned by `GET /api/marketplace/cache`.
 * @returns A multi-line string — one line per statistic.
 */
export function renderCacheStatus(status: CacheStatusResponse): string {
  const rows: Array<[string, string]> = [
    ['Marketplaces cached:', String(status.marketplaces)],
    ['Packages cached:', String(status.packages)],
    ['Total size:', formatBytes(status.totalSizeBytes)],
  ];

  const labelWidth = Math.max(...rows.map((r) => r[0].length));
  const valueWidth = Math.max(...rows.map((r) => r[1].length));

  return rows
    .map(([label, value]) => {
      const paddedLabel = label + ' '.repeat(labelWidth - label.length);
      const paddedValue = ' '.repeat(valueWidth - value.length) + value;
      return `${paddedLabel}  ${paddedValue}`;
    })
    .join('\n');
}

/**
 * Implements `dorkos cache list`.
 *
 * @returns The intended process exit code (`0` success, `1` error).
 */
export async function runCacheList(): Promise<number> {
  try {
    const status = await apiCall<CacheStatusResponse>('GET', '/api/marketplace/cache');
    console.log(renderCacheStatus(status));
    return 0;
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    return 1;
  }
}

/**
 * Implements `dorkos cache prune [--keep-last-n <N>]`.
 *
 * @param args - Parsed cache-prune arguments.
 * @returns The intended process exit code (`0` success, `1` error).
 */
export async function runCachePrune(args: CachePruneArgs): Promise<number> {
  try {
    const body = args.keepLastN !== undefined ? { keepLastN: args.keepLastN } : {};
    const result = await apiCall<PruneResponse>('POST', '/api/marketplace/cache/prune', body);

    const count = result.removed.length;
    if (count === 0) {
      console.log('Nothing to prune — cache is already minimal.');
      return 0;
    }

    const noun = count === 1 ? 'package' : 'packages';
    console.log(`Pruned ${count} cached ${noun}, freed ${formatBytes(result.freedBytes)}.`);
    return 0;
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    return 1;
  }
}

/**
 * Implements `dorkos cache clear [-y|--yes]`.
 *
 * Confirms destructively before wiping unless `--yes` is supplied. When
 * stdin is not a TTY (CI, pipes) and `--yes` was not passed, prints an
 * error and exits non-zero rather than silently cancelling — the user
 * invoked a destructive command and deserves an explicit signal.
 *
 * @param args - Parsed cache-clear arguments.
 * @returns The intended process exit code (`0` success, `1` error).
 */
export async function runCacheClear(args: CacheClearArgs): Promise<number> {
  if (!args.yes) {
    if (!process.stdin.isTTY) {
      console.error('Error: Cache clear requires --yes in non-interactive mode.');
      return 1;
    }
    const proceed = await confirm('Clear the entire marketplace cache?');
    if (!proceed) {
      console.log('Cache clear cancelled.');
      return 0;
    }
  }

  try {
    await apiCall<void>('DELETE', '/api/marketplace/cache');
    console.log('Cache cleared.');
    return 0;
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    return 1;
  }
}
