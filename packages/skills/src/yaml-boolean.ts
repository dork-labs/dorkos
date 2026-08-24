import { z } from 'zod';

/**
 * Coerce the YAML 1.1 boolean words a person actually types into booleans.
 *
 * `gray-matter` parses with js-yaml v4, which is YAML **1.2 core**: only
 * `true`/`false` are booleans there, so `yes`, `no`, `on`, `off`, `y`, `n` and
 * a quoted `"false"` all arrive as plain strings. Authors write those anyway —
 * they were valid YAML 1.1 for a decade and every other tool still takes them.
 * Rejecting one would fail the whole SKILL.md parse and make the entire skill
 * vanish from every surface, which is a far worse answer than reading what the
 * author plainly meant.
 *
 * Anything else passes through untouched for the schema to judge.
 *
 * @param value - Raw frontmatter value, straight from the YAML parser.
 * @internal Shared by the frontmatter schemas; use {@link readYamlBoolean}
 * outside them.
 */
export function coerceYamlBoolean(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === 'yes' || normalized === 'on' || normalized === 'y') {
    return true;
  }
  if (normalized === 'false' || normalized === 'no' || normalized === 'off' || normalized === 'n') {
    return false;
  }
  return value;
}

/**
 * A YAML-1.1-tolerant optional boolean (see {@link coerceYamlBoolean}).
 *
 * A value that is neither a boolean nor a recognized boolean word degrades to
 * absent rather than failing the parse: before these fields existed the schema
 * simply stripped the unknown key, and a typo in one optional field must not
 * delete a person's whole skill from the product.
 *
 * @internal Shared by the frontmatter schemas.
 */
export const OptionalYamlBoolean = z
  .preprocess(coerceYamlBoolean, z.boolean())
  .optional()
  .catch(undefined);

/**
 * Read a frontmatter value that is meant to be a boolean, the same way the
 * schema does: YAML 1.1 words count, and anything unreadable is `undefined`
 * (absent).
 *
 * Exported for the surfaces that read frontmatter *outside* a full schema
 * parse — `CommandRegistryService` validates with `.partial()` and falls back
 * to a hand-rolled key/value parser for malformed YAML, so it cannot rely on
 * the schema having coerced anything.
 *
 * @param value - Raw frontmatter value, straight from the YAML parser.
 */
export function readYamlBoolean(value: unknown): boolean | undefined {
  const coerced = coerceYamlBoolean(value);
  return typeof coerced === 'boolean' ? coerced : undefined;
}
