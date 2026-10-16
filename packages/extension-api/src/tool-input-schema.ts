/**
 * The JSON Schema subset an extension tool's declared input may use, and the
 * check that converts one declared schema to the Zod object the registry
 * parses calls against. Re-exported from `tool-check`, so callers import from
 * there.
 *
 * @module extension-api/tool-input-schema
 */
import { z } from 'zod';

/** The JSON Schema keywords an extension tool's input may use. */
const ALLOWED_KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'anyOf',
  'additionalProperties',
]);

/** Keywords refused with their own reason, because each opens the schema. */
const OPENING_KEYWORDS: Readonly<Record<string, string>> = {
  patternProperties: 'patternProperties makes an open-ended map',
  propertyNames: 'propertyNames makes an open-ended map',
  $ref: '$ref is not supported; write the schema out in full',
  $defs: '$defs is not supported; write the schema out in full',
  definitions: 'definitions is not supported; write the schema out in full',
};

/** The JSON types a `type` keyword may name. */
const JSON_TYPES: ReadonlySet<string> = new Set([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
]);

/**
 * Property names refused outright: each is a key JavaScript objects already
 * carry, and an input field named one would reach the handler as an own
 * property shadowing it (or, for `__proto__`, be dropped or re-parent the
 * object depending on who copies it).
 */
const RESERVED_PROPERTY_NAMES: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/** How deep an input schema may nest. Deeper is refused rather than walked. */
const MAX_SCHEMA_DEPTH = 12;

/** The longest refusal sentence kept, so an author's text cannot flood a card. */
const MAX_REASON_LENGTH = 300;

/** A plain keyword or property name, safe to repeat in a refusal sentence. */
const PLAIN_NAME = /^[A-Za-z_$][A-Za-z0-9_$-]{0,40}$/;

/** Name an author-chosen key in a sentence only when it is plainly a name. */
function named(key: string): string {
  return PLAIN_NAME.test(key) ? `"${key}"` : 'a keyword';
}

/**
 * One line of plain text, safe to show on a card: no control or invisible
 * characters, collapsed whitespace, capped length. Every refusal passes
 * through here because several carry text the author wrote (a property name,
 * a converter message quoting their pattern).
 *
 * @param reason - A refusal sentence.
 */
export function plainReason(reason: string): string {
  const flat = reason
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > MAX_REASON_LENGTH ? `${flat.slice(0, MAX_REASON_LENGTH - 1)}…` : flat;
}

/** Whether a value is a plain JSON object (not an array, not null). */
function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Whether a value is a JSON primitive an `enum` or `const` may hold. */
function isPrimitive(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/**
 * Find the first thing in one schema node outside the subset.
 *
 * Positional, not a blind key walk: `properties` maps names to schemas,
 * `items` and each `anyOf` entry are schemas, and `enum`, `const` and
 * `default` are data, never schemas.
 *
 * @returns Why the node is refused, or `undefined` when it is in the subset.
 */
function subsetProblem(node: unknown, where: string, depth: number): string | undefined {
  if (depth > MAX_SCHEMA_DEPTH) return `${where} nests deeper than ${MAX_SCHEMA_DEPTH} levels`;
  if (!isObject(node)) return `${where} is not a schema object`;
  for (const key of Object.keys(node)) {
    const opening = OPENING_KEYWORDS[key];
    if (opening) return `${where} uses ${opening}`;
    if (!ALLOWED_KEYWORDS.has(key)) return `${where} uses ${named(key)}, which is not supported`;
  }

  const type = node.type;
  const types = Array.isArray(type) ? type : type === undefined ? [] : [type];
  if (types.length === 0 && type !== undefined) return `${where} has an empty type list`;
  // An untyped node converts to "anything", an open hole in a closed schema.
  if (type === undefined && !('enum' in node) && !('const' in node) && !('anyOf' in node)) {
    return `${where} must say its type (or list its values with enum, const or anyOf)`;
  }
  if (types.includes('array') && !('items' in node)) {
    return `${where} is an array and must describe its items`;
  }
  for (const t of types) {
    if (typeof t !== 'string' || !JSON_TYPES.has(t)) return `${where} has an unknown type`;
  }

  const isObjectNode = types.includes('object') || 'properties' in node;
  if ('additionalProperties' in node && node.additionalProperties !== false) {
    return `${where} sets additionalProperties to something other than false, which makes an open-ended map`;
  }
  if (isObjectNode) {
    if (node.additionalProperties !== false) {
      return `${where} must set "additionalProperties": false`;
    }
    const properties = node.properties ?? {};
    if (!isObject(properties)) return `${where} has properties that are not an object`;
    for (const [key, child] of Object.entries(properties)) {
      if (RESERVED_PROPERTY_NAMES.has(key))
        return `${where} uses the reserved property name "${key}"`;
      const problem = subsetProblem(child, `property ${named(key)}`, depth + 1);
      if (problem) return problem;
    }
    if ('required' in node) {
      const required = node.required;
      if (!Array.isArray(required) || !required.every((k) => typeof k === 'string')) {
        return `${where} has a required list that is not a list of names`;
      }
      const missing = required.find((k) => !Object.hasOwn(properties, k));
      if (missing !== undefined)
        return `${where} requires ${named(missing)}, which it does not define`;
    }
  } else if ('required' in node) {
    return `${where} lists required fields but is not an object`;
  }

  if ('items' in node) {
    const problem = subsetProblem(node.items, `${where} items`, depth + 1);
    if (problem) return problem;
  }
  if ('anyOf' in node) {
    if (!Array.isArray(node.anyOf) || node.anyOf.length === 0) {
      return `${where} has an empty or invalid anyOf`;
    }
    for (const [index, option] of node.anyOf.entries()) {
      const problem = subsetProblem(option, `${where} option ${index + 1}`, depth + 1);
      if (problem) return problem;
    }
  }
  if ('enum' in node) {
    if (!Array.isArray(node.enum) || node.enum.length === 0 || !node.enum.every(isPrimitive)) {
      return `${where} has an enum that is not a list of plain values`;
    }
  }
  if ('const' in node && !isPrimitive(node.const))
    return `${where} has a const that is not a plain value`;
  for (const key of ['description', 'title', 'pattern', 'format'] as const) {
    if (key in node && typeof node[key] !== 'string')
      return `${where} has a ${key} that is not text`;
  }
  for (const key of ['minimum', 'maximum'] as const) {
    if (key in node && (typeof node[key] !== 'number' || !Number.isFinite(node[key]))) {
      return `${where} has a ${key} that is not a number`;
    }
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
    const value = node[key];
    if (key in node && !(Number.isInteger(value) && (value as number) >= 0)) {
      return `${where} has a ${key} that is not a whole number`;
    }
  }
  // The converter passes a default through untouched, so one that breaks its
  // own schema would reach the handler as if a caller had sent it.
  if ('default' in node) {
    const { default: fallback, ...rest } = node;
    let fits: boolean;
    try {
      fits = z
        .fromJSONSchema(rest as Parameters<typeof z.fromJSONSchema>[0])
        .safeParse(fallback).success;
    } catch {
      fits = false;
    }
    if (!fits) return `${where} has a default that does not fit its own schema`;
  }
  return undefined;
}

/**
 * Check one declared input schema and convert it to the Zod object the
 * registry parses calls against.
 *
 * @param json - The `inputSchema` exactly as `extension.json` declares it.
 * @returns The converted Zod object, or why the schema is refused.
 */
export function checkToolInputSchema(
  json: unknown
): { ok: true; zod: z.ZodObject } | { ok: false; reason: string } {
  if (!isObject(json) || json.type !== 'object') {
    return { ok: false, reason: 'the input schema must be an object schema ("type": "object")' };
  }
  const problem = subsetProblem(json, 'the input schema', 0);
  if (problem) return { ok: false, reason: plainReason(problem) };
  let converted: unknown;
  try {
    converted = z.fromJSONSchema(json as Parameters<typeof z.fromJSONSchema>[0]);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: plainReason(`the input schema could not be read: ${why}`) };
  }
  if (!(converted instanceof z.ZodObject)) {
    return { ok: false, reason: 'the input schema did not convert to an object schema' };
  }
  return { ok: true, zod: converted };
}
