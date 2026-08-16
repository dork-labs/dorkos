/**
 * Settings written by a build that is not this one.
 *
 * ## The defect this exists for
 *
 * A key in `config.json` that this build's schema does not declare is **version
 * skew, not corruption**. It happens constantly on a machine that runs more than
 * one build of DorkOS — a newer build writes `runtimes.claudeCode.<something
 * new>`, then an older one starts; or a migration retires a key and the config
 * file has not met that migration yet. It also happens on the one machine where
 * DorkOS is developed, several times a day.
 *
 * The config schema is generated from Zod, which closes every object
 * (`additionalProperties: false`), and `conf` validates with Ajv on **every read
 * of the file** — not just at boot. So one unrecognized key made the whole file
 * unloadable, the recovery path read that as corruption, and the person's
 * settings were replaced with defaults. Observed five times on one machine, most
 * recently over `ui`, `ui/sidebar` and `runtimes/claudeCode` together.
 *
 * ## The rule
 *
 * An unrecognized key never condemns a file. It is ignored in memory — nothing
 * reads it, and it is absent from the `UserConfig` type — and preserved on disk
 * for the build that owns it. Those two cases are told apart structurally, by
 * making the validator stop treating unknown keys as violations at all, rather
 * than by reading Ajv's error text after the fact.
 *
 * ## The other direction
 *
 * This module covers a key this build does not DECLARE. A key it declares whose
 * stored VALUE a newer build widened — a new enum member, a raised bound, a
 * retyped leaf — is the same argument at the other end, and lives next door in
 * `widened-leaves.ts` (DOR-1227). Together they are the whole of "settings
 * written by a build that is not this one"; anything left over really is damage.
 *
 * @module services/core/config/version-skew
 */

/**
 * Whether a value is a JSON object rather than an array, `null`, or a scalar.
 *
 * @param value - The value to test.
 * @returns `true` when it is a plain object.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Stop a generated JSON Schema from rejecting keys it does not declare.
 *
 * Rewrites every `additionalProperties: false` in the tree to `true`, in place,
 * wherever it appears — inside `properties`, `items`, `anyOf`, `$defs`, all of
 * it. A node whose `additionalProperties` is a SCHEMA rather than `false` is
 * left alone: that is a record type, where the extra keys are the data and their
 * shape is still worth checking.
 *
 * Everything else this function sees still applies — a wrong-shaped section, a
 * list where an object belongs, a missing required field all still fail, which
 * is what keeps this tolerance from becoming "validate nothing". The one further
 * relaxation is `relaxWidenedLeaves` in `widened-leaves.ts`, which opens named
 * scalar leaves and hands their checking to Zod inside DorkOS; it is applied
 * after this one and is deliberately a separate, narrower cut.
 *
 * @param schema - The generated schema, mutated in place.
 */
export function tolerateUnknownKeys(schema: unknown): void {
  if (Array.isArray(schema)) {
    for (const item of schema) tolerateUnknownKeys(item);
    return;
  }
  if (!isPlainObject(schema)) return;
  if (schema.additionalProperties === false) schema.additionalProperties = true;
  for (const value of Object.values(schema)) tolerateUnknownKeys(value);
}

/**
 * The schema node describing one dot-path into the config, if there is one.
 *
 * @param sections - The per-top-level-key schema map conf validates against.
 * @param dotPath - A config path such as `runtimes.claudeCode`.
 * @returns The node, or `undefined` when the path is not a declared object path
 *   (an array index, a record key, or a key this build does not know).
 */
export function schemaNodeAt(
  sections: Record<string, unknown>,
  dotPath: string
): Record<string, unknown> | undefined {
  const [head, ...rest] = dotPath.split('.');
  if (head === undefined) return undefined;
  let node = sections[head];
  for (const segment of rest) {
    if (!isPlainObject(node)) return undefined;
    const properties = node.properties;
    if (!isPlainObject(properties)) return undefined;
    node = properties[segment];
  }
  return isPlainObject(node) ? node : undefined;
}

/**
 * Carry keys this build does not declare from the stored value onto the value
 * about to replace it.
 *
 * Tolerating an unknown key on the way IN is only half of it. Every write goes
 * through Zod, which strips what it does not declare, so an older build that
 * merely saved a theme would quietly delete the newer build's settings from the
 * file — the same data loss as a wipe, arriving one preference at a time.
 *
 * Only keys absent from the schema's own `properties` are carried, and only into
 * objects the schema describes with `properties`. A record type (`properties`
 * absent, `additionalProperties` a schema) is left to the writer: there, every
 * key is data the caller owns, and re-adding one it just removed would resurrect
 * a deletion. That carve-out is load-bearing rather than tidy —
 * `ui.sidebar.sections` is a record whose unknown ids `dropUnknownSectionIds`
 * removes ON PURPOSE at the next write, and carrying them back would undo it.
 *
 * Arrays are left alone for a related reason: position is not identity, so
 * matching a stored item to a written one by index would be a guess, and a
 * wrong guess writes one person's setting onto another's row. The cost is worth
 * naming — an unknown key nested INSIDE an array item (`ui.sidebar.groups[]`,
 * `runtimes.claudeCode.accounts[]`) is dropped when this build writes that whole
 * section. It survives every boot and every write that does not touch its
 * section, which is the common case.
 *
 * @param node - The schema node describing `next`, from {@link schemaNodeAt}.
 * @param stored - The value currently on disk.
 * @param next - The value about to be written.
 * @returns `next` unchanged when there is nothing to carry, otherwise a copy
 *   carrying the unrecognized keys.
 */
export function preserveUnknownKeys(node: unknown, stored: unknown, next: unknown): unknown {
  if (!isPlainObject(node) || !isPlainObject(stored) || !isPlainObject(next)) return next;
  const properties = node.properties;
  if (!isPlainObject(properties)) return next;

  let merged: Record<string, unknown> | undefined;
  const carry = (key: string, value: unknown): void => {
    merged ??= { ...next };
    merged[key] = value;
  };

  for (const [key, value] of Object.entries(stored)) {
    if (!(key in properties)) {
      // Unrecognized. It belongs to another build, so it survives — unless this
      // write names it, which only a caller that knows about it can do.
      if (!(key in next)) carry(key, value);
      continue;
    }
    // Recognized, so this build owns it; recurse in case something unrecognized
    // is nested underneath.
    const nested = preserveUnknownKeys(properties[key], value, next[key]);
    if (nested !== next[key]) carry(key, nested);
  }

  return merged ?? next;
}
