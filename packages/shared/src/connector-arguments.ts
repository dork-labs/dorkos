/**
 * Check a value an agent sent against a provider's frozen JSON Schema without
 * changing it.
 *
 * Connector operation arguments and event filters are bound, byte for byte,
 * into an authority digest before anything reaches a provider: what an owner
 * approved and what the audit trail records must be exactly what is sent.
 * Validation therefore has to be a pure yes/no. It may never fill, coerce or
 * drop a field.
 *
 * `z.fromJSONSchema` is not that on its own. It turns every JSON Schema
 * `default` into a Zod `.default()`, so parsing a call that leaves out a
 * defaulted field hands back a different object from the one sent. Provider
 * schemas (Composio's among them) put a `default` on most optional fields, so
 * comparing the parsed value with the sent one refused nearly every real call:
 * `GMAIL_FETCH_EMAILS` with `{}` parsed to six filled-in fields. The fix is to
 * validate against a copy of the schema with `default` removed. A default is an
 * annotation in JSON Schema, never a constraint, so removing it changes what
 * the schema accepts not at all; the provider still applies its own defaults
 * when the call arrives.
 *
 * The copy is also closed at the top level: a key the operation does not
 * declare is refused rather than forwarded, because a provider silently
 * ignores a misspelt parameter (`maxResults` for `max_results`) and the agent
 * would never learn its filter did nothing.
 *
 * @module shared/connector-arguments
 */
import { z } from 'zod';
import { stableStringify } from './capabilities.js';

/** Longest problem description returned, so a hostile key name cannot flood a refusal. */
const MAX_PROBLEM_LENGTH = 200;

/** Keywords whose value is one subschema. */
const SINGLE_SUBSCHEMA_KEYWORDS = [
  'additionalItems',
  'additionalProperties',
  'contains',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
] as const;

/** Keywords whose value is a list of subschemas. */
const SUBSCHEMA_LIST_KEYWORDS = ['allOf', 'anyOf', 'items', 'oneOf', 'prefixItems'] as const;

/** Keywords whose value maps names to subschemas. */
const SUBSCHEMA_MAP_KEYWORDS = [
  '$defs',
  'definitions',
  'dependentSchemas',
  'patternProperties',
  'properties',
] as const;

/** Keywords that already say what happens to a key the schema does not name. */
const OPEN_OBJECT_KEYWORDS = [
  'additionalProperties',
  'patternProperties',
  'unevaluatedProperties',
  // A composed or referenced root is judged by its parts; closing it here
  // would refuse keys a branch or the referenced definition declares.
  '$ref',
  'allOf',
  'anyOf',
  'oneOf',
] as const;

/** Outcome of checking one value against a provider schema. */
export type ConnectorArgumentsCheck =
  | { readonly ok: true }
  /**
   * `problem` names the first field at fault and what is wrong with it, never
   * the value that was sent. It is `undefined` when the value was refused for a
   * reason with no single field to blame.
   */
  | { readonly ok: false; readonly reason: 'mismatch'; readonly problem?: string }
  /** The stored schema itself could not be turned into a validator. */
  | { readonly ok: false; readonly reason: 'schema_unreadable' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A copy of one schema node with every `default` annotation removed, recursively. */
function withoutDefaults(node: unknown): unknown {
  if (!isRecord(node)) return node;
  const copy: Record<string, unknown> = {};
  for (const [keyword, value] of Object.entries(node)) {
    if (keyword === 'default') continue;
    copy[keyword] = value;
  }
  for (const keyword of SINGLE_SUBSCHEMA_KEYWORDS) {
    if (isRecord(copy[keyword])) copy[keyword] = withoutDefaults(copy[keyword]);
  }
  for (const keyword of SUBSCHEMA_LIST_KEYWORDS) {
    const list = copy[keyword];
    if (Array.isArray(list)) copy[keyword] = list.map(withoutDefaults);
  }
  for (const keyword of SUBSCHEMA_MAP_KEYWORDS) {
    const map = copy[keyword];
    if (!isRecord(map)) continue;
    // Map keys are names (a property may well be called `default`), so only
    // the values are schema nodes.
    copy[keyword] = Object.fromEntries(
      Object.entries(map).map(([name, subschema]) => [name, withoutDefaults(subschema)])
    );
  }
  return copy;
}

/**
 * The schema a value is checked against: the provider's schema with its
 * `default` annotations removed and, when the root declares its properties and
 * says nothing about other keys, closed to keys it does not declare.
 *
 * Exported for its tests alone: zod 4.6 happens to ignore a root's
 * `additionalProperties: false` beside `allOf`, `anyOf`, `oneOf`, `$ref` and
 * `patternProperties`, so behaviour alone cannot show the root was left open
 * for them, and standard JSON Schema (or a later zod) would refuse keys their
 * parts declare.
 *
 * @param providerSchema - The provider's schema, as stored.
 * @returns The schema {@link checkConnectorArguments} validates against.
 * @internal
 */
export function connectorValidationSchema(
  providerSchema: Record<string, unknown>
): Record<string, unknown> {
  const schema = withoutDefaults(providerSchema) as Record<string, unknown>;
  const closable =
    isRecord(schema.properties) && OPEN_OBJECT_KEYWORDS.every((keyword) => !(keyword in schema));
  return closable ? { ...schema, additionalProperties: false } : schema;
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String).join('.');
  const problem = path ? `${path}: ${issue.message}` : issue.message;
  return problem.length > MAX_PROBLEM_LENGTH
    ? `${problem.slice(0, MAX_PROBLEM_LENGTH - 1)}…`
    : problem;
}

/**
 * Check `value` against a provider's frozen JSON Schema, exactly as sent.
 *
 * Accepts only when the value satisfies the schema AND validation changed
 * nothing about it, so the caller can bind and forward the very object the
 * agent sent. Defaults are never filled in, and a top-level key the schema does
 * not declare is refused (see the module comment for why).
 *
 * @param providerSchema - The operation's input schema, or an event's filter schema, as stored.
 * @param value - The arguments or filter the agent sent.
 * @returns Whether the value is acceptable, and if not, the first field at fault.
 */
export function checkConnectorArguments(
  providerSchema: Record<string, unknown>,
  value: unknown
): ConnectorArgumentsCheck {
  let validator: z.ZodType;
  try {
    validator = z.fromJSONSchema(connectorValidationSchema(providerSchema));
  } catch {
    return { ok: false, reason: 'schema_unreadable' };
  }
  const result = validator.safeParse(value);
  if (!result.success) {
    const [issue] = result.error.issues;
    return issue
      ? { ok: false, reason: 'mismatch', problem: describeIssue(issue) }
      : { ok: false, reason: 'mismatch' };
  }
  // With no defaults left the parse should hand back what it was given; this
  // is the guard that proves it, should a future schema keyword ever transform.
  return stableStringify(result.data) === stableStringify(value)
    ? { ok: true }
    : { ok: false, reason: 'mismatch' };
}
