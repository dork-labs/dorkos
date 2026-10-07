/**
 * One spelling of a value as JSON, so a hash over it is reproducible anywhere
 * (spec `audit-trail` §3.1).
 *
 * The audit chain hashes each row. A hash is only checkable if everyone who
 * recomputes it serializes the row byte for byte the same way, and
 * `JSON.stringify` does not promise that: key order follows insertion order, so
 * two equal objects built in a different order hash differently. The rules here
 * are the whole contract a verifier in another process (or another language)
 * has to follow:
 *
 * - object keys sorted by UTF-16 code unit order, at every depth;
 * - keys whose value is `undefined` dropped, as `JSON.stringify` drops them;
 * - `null`, booleans, numbers and strings spelled as `JSON.stringify` spells them;
 * - arrays keep their order; no whitespace anywhere;
 * - only plain objects: a `Date`, `Map` or class instance is refused, never
 *   flattened to `{}`.
 *
 * @module services/audit/canonical-json
 */

/**
 * Serialize a JSON-compatible value canonically.
 *
 * @param value - Anything `JSON.stringify` accepts without a replacer. Functions,
 *   symbols and `undefined` inside arrays are refused rather than guessed at,
 *   because no row this module hashes can carry one.
 * @returns The canonical JSON text.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => {
        if (item === undefined) throw new TypeError('canonicalJson: undefined in array');
        return canonicalJson(item);
      })
      .join(',')}]`;
  }
  if (typeof value === 'object') {
    // A Date, Map, class instance or the like has no single JSON spelling
    // (`Object.keys` of a Date is empty, so it would hash as `{}` and two
    // different dates would collide). Refused, so a caller converts it first.
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError('canonicalJson: only plain objects are serializable');
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new TypeError(`canonicalJson: cannot serialize a ${typeof value}`);
}
