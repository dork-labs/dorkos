/**
 * Read the `CONFIG_MIGRATIONS` table as TEXT: its keys, in order.
 *
 * Text, not an import, for two callers that must not run the file. The daily
 * release reads the release point as data and runs nothing from it, and the
 * PR check (`scripts/config-migration/check-config-migration.ts`) reads the
 * base commit's copy through `git show`. It lives here, not beside that
 * check, because the daily release's sparse checkout of main's tools holds
 * only `scripts/release/`. A table this reader cannot read exactly is an
 * error, never an empty list, because an empty list would read as "no
 * migration to wait for".
 *
 * @module scripts/release/migration-table
 */

/** Where the table lives, repo-relative. */
export const MIGRATIONS_FILE = 'apps/server/src/services/core/config-migrations/index.ts';

/**
 * The legacy sentinel at the front of the table. It seeds `version: 1`, sits
 * above every 0.x version, and so runs for nobody while DorkOS is 0.x
 * (`config-manager.test.ts` pins it first). It is not a pending migration.
 */
export const LEGACY_SENTINEL_KEY = '1.0.0';

const START = /^export const CONFIG_MIGRATIONS\b[^=]*=\s*\{\s*$/;
const END = /^\}/;
const KEY_LINE = /^ {2}(['"])([^'"]+)\1\s*:/;
// A line at the table's own indent that opens something other than a closing
// bracket or a comment: it must be a quoted key, or the reader cannot place it.
const ENTRY_START = /^ {2}[^\s}\])/*]/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The table's keys, in table order; throws when it cannot read the table exactly. */
export function readMigrationTable(text: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => START.test(line));
  if (start === -1) throw new Error('has no `export const CONFIG_MIGRATIONS = {` line');
  const end = lines.findIndex((line, index) => index > start && END.test(line));
  if (end === -1) throw new Error('never closes the CONFIG_MIGRATIONS table');

  const keys: string[] = [];
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index]!;
    const key = KEY_LINE.exec(line)?.[2];
    if (key !== undefined) {
      if (!SEMVER.test(key)) throw new Error(`has a key that is not X.Y.Z: '${key}'`);
      if (keys.includes(key)) throw new Error(`repeats the key '${key}'`);
      keys.push(key);
    } else if (ENTRY_START.test(line)) {
      throw new Error(`line ${index + 1} opens an entry that is not a quoted key: ${line.trim()}`);
    }
  }
  if (!keys.length) throw new Error('has no keys in CONFIG_MIGRATIONS');
  return keys;
}

/** Parse `X.Y.Z`, or undefined when it is not one. */
export function parseSemver(value: string): [number, number, number] | undefined {
  const match = SEMVER.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** Negative, zero or positive as `a` is older than, equal to or newer than `b` (both `X.Y.Z`). */
export function compareSemver(a: string, b: string): number {
  const [x, y] = [parseSemver(a), parseSemver(b)];
  if (!x || !y) throw new Error(`not X.Y.Z: ${x ? b : a}`);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/**
 * The keys still to run for a user on `released`: every key above it, the
 * legacy sentinel left out while it is the table's first entry.
 */
export function pendingKeys(keys: readonly string[], released: string): string[] {
  return keys
    .filter((key, index) => !(index === 0 && key === LEGACY_SENTINEL_KEY))
    .filter((key) => compareSemver(key, released) > 0);
}
