/**
 * CLI handler for `dorkos marketplace list`.
 *
 * Calls `GET /api/marketplace/sources` and renders the result as a small
 * fixed-width table, with how each source's last listing fetch went and, under
 * the table, why any of them failed (DOR-2324). Empty state prints a friendly
 * hint pointing at `marketplace add`.
 *
 * @module commands/marketplace-list
 */
import { parseArgs } from 'node:util';
import type { SourceLastFetch } from '@dorkos/shared/marketplace-schemas';
import { ApiError, apiCall } from '../lib/api-client.js';
import { rethrowUnknownOption } from '../lib/parse-args-error.js';

/** Marketplace source as returned by the server `/sources` endpoints. */
interface MarketplaceSource {
  name: string;
  source: string;
  enabled: boolean;
  addedAt?: string;
  /** How the last listing fetch went. Absent from servers older than DOR-2324. */
  lastFetch?: SourceLastFetch;
}

/** Response shape for `GET /api/marketplace/sources`. */
interface ListSourcesResponseBody {
  sources: MarketplaceSource[];
}

/** One-line usage string surfaced in error messages. */
const USAGE_LINE = 'Usage: dorkos marketplace list';

/** Maximum width for any single column. Longer values are truncated with `...`. */
const MAX_COLUMN_WIDTH = 60;

/**
 * Parse the raw argv slice that follows `dorkos marketplace list`. The
 * subcommand currently takes no arguments, so we only validate that no
 * unknown options were passed.
 *
 * @param rawArgs - The argv slice after `marketplace list`.
 */
export function parseMarketplaceListArgs(rawArgs: string[]): void {
  try {
    parseArgs({
      args: rawArgs,
      options: {},
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    rethrowUnknownOption(err, 'marketplace list', USAGE_LINE);
  }
}

/**
 * Truncate a string to {@link MAX_COLUMN_WIDTH}, replacing the trailing
 * characters with `...` so the column width budget is preserved.
 */
function truncate(value: string): string {
  if (value.length <= MAX_COLUMN_WIDTH) return value;
  return `${value.slice(0, MAX_COLUMN_WIDTH - 3)}...`;
}

/**
 * Pad a string with spaces on the right to the given width. Used for
 * fixed-width column rendering since every value has already been
 * passed through {@link truncate}.
 */
function padRight(value: string, width: number): string {
  if (value.length >= width) return value;
  return value + ' '.repeat(width - value.length);
}

/** "12 packages" / "1 package". */
function packages(count: number): string {
  return `${count} ${count === 1 ? 'package' : 'packages'}`;
}

/** The PACKAGES cell: what a person can install from the source right now. */
function packagesCell(lastFetch: SourceLastFetch | undefined): string {
  switch (lastFetch?.state) {
    case 'fetched':
      return packages(lastFetch.packageCount);
    case 'stale':
      return `${packages(lastFetch.packageCount)} (older copy)`;
    case 'failed':
      return "didn't load";
    case 'never':
      return 'not fetched yet';
    default:
      return '';
  }
}

/** The line under the table that says why a source's last fetch failed. */
function failureNote(name: string, lastFetch: SourceLastFetch | undefined): string | null {
  if (lastFetch?.state === 'failed') {
    return (
      `${name}: its packages didn't load: ${lastFetch.reason.replace(/\.$/, '')}. ` +
      `Run \`dorkos marketplace refresh ${name}\` to try again.`
    );
  }
  if (lastFetch?.state === 'stale') {
    const when = new Date(lastFetch.copyFetchedAt).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    return (
      `${name}: couldn't fetch its listing: ${lastFetch.reason.replace(/\.$/, '')}. ` +
      `Still listing the copy from ${when}.`
    );
  }
  return null;
}

/**
 * Render the table for {@link runMarketplaceList}. Extracted as a pure
 * function so tests can verify formatting without mocking I/O.
 *
 * @param sources - The list of sources to render.
 * @returns A multi-line string with a header row, one row per source, and a
 *   line for each source whose last listing fetch failed.
 */
export function renderSourcesTable(sources: MarketplaceSource[]): string {
  const headers = { name: 'NAME', source: 'SOURCE', enabled: 'ENABLED', packages: 'PACKAGES' };
  const rows = sources.map((s) => ({
    name: truncate(s.name),
    source: truncate(s.source),
    enabled: s.enabled ? 'yes' : 'no',
    packages: packagesCell(s.lastFetch),
  }));

  // Column widths derived from the widest cell (header included), capped by
  // truncate() above. Two spaces between columns is enough whitespace to
  // keep the table readable without padding it out unnecessarily wide.
  const nameWidth = Math.max(headers.name.length, ...rows.map((r) => r.name.length));
  const sourceWidth = Math.max(headers.source.length, ...rows.map((r) => r.source.length));
  const enabledWidth = Math.max(headers.enabled.length, ...rows.map((r) => r.enabled.length));

  // A server older than DOR-2324 sends no lastFetch at all: leave the column
  // out rather than draw an empty one.
  const showPackages = sources.some((s) => s.lastFetch !== undefined);
  const formatRow = (name: string, source: string, enabled: string, pkgs: string): string =>
    `${padRight(name, nameWidth)}  ${padRight(source, sourceWidth)}  ${padRight(enabled, enabledWidth)}${
      showPackages ? `  ${pkgs}` : ''
    }`.trimEnd();

  const lines = [formatRow(headers.name, headers.source, headers.enabled, headers.packages)];
  for (const row of rows) {
    lines.push(formatRow(row.name, row.source, row.enabled, row.packages));
  }
  const notes = sources
    .map((s) => failureNote(s.name, s.lastFetch))
    .filter((note): note is string => note !== null);
  if (notes.length > 0) lines.push('', ...notes);
  return lines.join('\n');
}

/**
 * Implements `dorkos marketplace list`.
 *
 * @returns The intended process exit code (`0` success, `1` error).
 */
export async function runMarketplaceList(): Promise<number> {
  try {
    const { sources } = await apiCall<ListSourcesResponseBody>('GET', '/api/marketplace/sources');

    if (sources.length === 0) {
      console.log("No marketplaces configured. Run 'dorkos marketplace add <url>' to add one.");
      return 0;
    }

    console.log(renderSourcesTable(sources));
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
