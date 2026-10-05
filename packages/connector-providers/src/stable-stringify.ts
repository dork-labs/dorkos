/**
 * Deterministic JSON serialization with recursively sorted object keys.
 *
 * Dependency-free so any surface (server, CLI, browser, hosted service) can
 * recompute or verify a hash over the same canonical form.
 *
 * @module connector-providers/stable-stringify
 */

/**
 * Deterministically serialize a JSON-compatible value with object keys sorted
 * recursively, so two structurally-equal values with different key insertion
 * order produce byte-identical output.
 *
 * This is the canonical form the catalog content hash is computed over: it
 * makes `catalogVersion` depend only on the catalog's content, never on the
 * order fields happen to be written in. Array order is preserved (it is
 * meaningful); only object keys are sorted. Pure and dependency-free so any
 * surface can recompute or verify a version.
 *
 * ## Plain data only
 *
 * Canonicalization rebuilds every object from its own enumerable keys, which
 * bypasses `toJSON` and sees nothing inside a `Set` or `Map`. So a `Date` loses
 * its instant and `new Set(['a'])` serializes the same as `new Set(['b'])`. That
 * is fine for the catalog (plain serialized schemas) and NOT fine for anything
 * security-relevant: `hashApprovalInput` therefore rejects non-plain values
 * before calling this, rather than hashing a value it would silently flatten.
 *
 * @param value - Any plain JSON value. Dates, Sets, Maps, and class instances
 *   lose information here; do not pass them.
 * @returns A stable JSON string with all object keys sorted.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/**
 * Recursively return a structural copy of `value` with every object's keys in
 * sorted order. Arrays keep their order; primitives pass through.
 *
 * @param value - The value to canonicalize.
 * @returns A key-sorted structural copy.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
