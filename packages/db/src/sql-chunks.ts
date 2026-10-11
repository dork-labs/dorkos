/**
 * Keep an `IN (...)` list under SQLite's limit on bound variables.
 *
 * Every value in `inArray(column, values)` is one bound variable, and SQLite
 * refuses a statement past its limit (999 on older builds). A lookup over an
 * open-ended list, such as every session in the search index, runs once per
 * chunk instead.
 *
 * @module @dorkos/db/sql-chunks
 */

/** How many values one `IN (...)` list binds at most. */
export const SQL_IN_CHUNK = 500;

/**
 * `values` in consecutive slices of at most `size`.
 *
 * @param values - The full list.
 * @param size - The most per slice.
 */
export function chunked<T>(values: readonly T[], size: number = SQL_IN_CHUNK): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    chunks.push(values.slice(start, start + size));
  }
  return chunks;
}
