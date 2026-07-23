/**
 * Shared output helpers for the operator verbs (`agent`, `task`, `activity`,
 * `version`).
 *
 * Every operator verb accepts `--json` for machine output: the raw payload is
 * written to stdout as pretty-printed JSON with nothing else, so a caller can
 * pipe it straight into `jq` or `JSON.parse`. Human output uses a small
 * fixed-width table renderer. Errors always go to stderr as a plain one-liner —
 * never to stdout — so `--json` stdout stays clean (empty) on failure.
 *
 * @module lib/operator-output
 */
import { ApiError } from './api-client.js';

/**
 * Write a value to stdout as pretty-printed JSON followed by a newline. Used by
 * every operator verb's `--json` branch so machine output is uniform.
 *
 * @param value - The payload to serialize.
 */
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Render an error to stderr as a single `Error: <message>` line. {@link ApiError}
 * carries the server's message (from the JSON error body), so a 4xx surfaces the
 * server's own words; any other error falls back to its message string.
 *
 * @param err - The thrown error.
 */
export function printError(err: unknown): void {
  if (err instanceof ApiError) {
    console.error(`Error: ${err.message}`);
    return;
  }
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
}

/**
 * Render a fixed-width text table. Columns are padded to the widest cell (header
 * included). Returns a header row, a dashed separator, and one line per data
 * row. An empty `rows` array renders just the header + separator.
 *
 * @param headers - Column headings.
 * @param rows - Row cells, one string array per row (same length as `headers`).
 * @returns The rendered multi-line table.
 */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const pad = (cell: string, i: number): string => cell + ' '.repeat(widths[i] - cell.length);
  const line = (cells: string[]): string => cells.map((c, i) => pad(c ?? '', i)).join('  ');
  const separator = widths.map((w) => '-'.repeat(w)).join('  ');
  return [line(headers), separator, ...rows.map((r) => line(r))].join('\n');
}
