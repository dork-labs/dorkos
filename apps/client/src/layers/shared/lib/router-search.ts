/**
 * How the app's router reads and writes the query string.
 *
 * TanStack Router's default treats every value as JSON: `?entry=12` reads as
 * the number 12, and a string that would read as something else is written
 * back quoted, so the string `'12'` becomes `?q=%2212%22`. The app's own typed
 * search params rely on that, and keep it.
 *
 * What the default gets wrong is text that only LOOKS like JSON. It reads
 * `?v=1.10` as the number 1.1 and `?n=-0` as 0, so the address changes the
 * moment the router touches it, and it cannot tell `?q="x"` (a value with
 * quotes in it) from `?q=x`. Extension pages are handed their query as plain
 * text (spec `flow-multiproject` §6.5), so for them that is lost data.
 *
 * The rule here is the default's, made exact: a value is read as JSON only
 * when writing that JSON back gives the same text, and a string is quoted only
 * when it would otherwise read back as something else. So every address
 * survives a read and a write unchanged, and every value the app writes reads
 * back as itself.
 *
 * @module shared/lib/router-search
 */
import { parseSearchWith, stringifySearchWith } from '@tanstack/react-router';

/** Text that could be JSON: the same test TanStack's default parser uses. */
const JSON_START = /^(?:\s|["[{\d-]|fa|nu|tr)/;

/**
 * Read one query value.
 *
 * - An object or array reads as one.
 * - A number, `true`, `false` or `null` reads as one only in its canonical
 *   spelling (`3`, not `03` or `3.0`); anything else stays text.
 * - A quoted string loses its quotes only when they were an escape — when the
 *   text inside would not have read as itself without them (`"3"` → `'3'`). A
 *   value that merely has quotes in it (`"x"`) stays exactly that.
 *
 * @param raw - The decoded value, as the URL holds it.
 * @internal Exported for testing.
 */
export function readSearchValue(raw: string): unknown {
  if (!JSON_START.test(raw)) return raw;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (typeof value === 'string') return readSearchValue(value) === value ? raw : value;
  if (value !== null && typeof value === 'object') return value;
  return String(value) === raw ? value : raw;
}

/** Parse a query string: the router's `parseSearch`. */
export const parseAppSearch = parseSearchWith(readSearchValue);

/**
 * Write a query string: the router's `stringifySearch`. Objects are written as
 * JSON; a string is quoted only when it would not read back as itself.
 *
 * `stringifySearchWith` quotes a string exactly when its `parser` argument
 * returns instead of throwing, so the parser here throws for every string that
 * already reads back unchanged.
 */
export const stringifyAppSearch = stringifySearchWith(JSON.stringify, (text: string) => {
  if (readSearchValue(text) === text) throw new Error('reads back unchanged');
  return text;
});
