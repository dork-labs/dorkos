/**
 * A small, STRICT JSON Schema check for the protocol tests: enough of the
 * vocabulary the generated Codex schemas use (`$ref`, `oneOf`/`anyOf`/`allOf`,
 * `type`, `enum`, `properties`, `required`, `items`, `additionalProperties`).
 *
 * Strict where JSON Schema is lax, on purpose: an object key the schema does
 * not name is an error unless the schema explicitly allows extra keys. The
 * server silently drops an unknown param (spike 1c), so "not named" is exactly
 * the typo this exists to catch.
 */

type Schema = Record<string, unknown>;

/**
 * Every reason `value` does not conform to `schema`; empty when it does.
 *
 * @param value - The value to check.
 * @param schema - The schema.
 * @param defs - Definitions `$ref`s resolve against.
 * @param at - JSON path, for messages.
 */
export function schemaErrors(
  value: unknown,
  schema: unknown,
  defs: Record<string, unknown>,
  at = '$'
): string[] {
  if (schema === true || schema === undefined) return [];
  if (schema === false) return [`${at}: not allowed`];
  const s = schema as Schema;
  if (typeof s.$ref === 'string') {
    const name = s.$ref.replace('#/definitions/', '');
    if (!(name in defs)) return [`${at}: unresolved ${s.$ref}`];
    const { $ref: _ref, ...rest } = s;
    return [...schemaErrors(value, defs[name], defs, at), ...schemaErrors(value, rest, defs, at)];
  }
  const errors: string[] = [];
  for (const sub of (s.allOf as unknown[] | undefined) ?? []) {
    errors.push(...schemaErrors(value, sub, defs, at));
  }
  for (const key of ['oneOf', 'anyOf'] as const) {
    const options = s[key] as unknown[] | undefined;
    if (options && !options.some((option) => schemaErrors(value, option, defs, at).length === 0)) {
      errors.push(`${at}: matches no ${key} branch`);
    }
  }
  if (Array.isArray(s.enum) && !s.enum.some((option) => option === value)) {
    errors.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(s.enum)}`);
  }
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!types.some((type) => isType(value, type))) {
      errors.push(`${at}: expected ${types.join('|')}, got ${JSON.stringify(value)}`);
      return errors;
    }
  }
  if (Array.isArray(value) && s.items !== undefined) {
    value.forEach((item, index) =>
      errors.push(...schemaErrors(item, s.items, defs, `${at}[${index}]`))
    );
  }
  if (isObject(value) && (s.properties !== undefined || s.additionalProperties !== undefined)) {
    const props = (s.properties ?? {}) as Record<string, unknown>;
    for (const required of (s.required as string[] | undefined) ?? []) {
      if (!(required in value)) errors.push(`${at}.${required}: required`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key in props) {
        errors.push(...schemaErrors(child, props[key], defs, `${at}.${key}`));
      } else if (s.additionalProperties && s.additionalProperties !== true) {
        errors.push(...schemaErrors(child, s.additionalProperties, defs, `${at}.${key}`));
      } else if (s.additionalProperties !== true) {
        errors.push(`${at}.${key}: the schema names no such key`);
      }
    }
  }
  return errors;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isType(value: unknown, type: string): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'object':
      return isObject(value);
    case 'array':
      return Array.isArray(value);
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    default:
      return typeof value === type;
  }
}
