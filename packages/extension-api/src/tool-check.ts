/**
 * Which tools an extension may give agents, decided from what its author wrote
 * (spec `extension-agent-tools-and-skills` §1-§2, DOR-2685).
 *
 * Pure checks with no server dependency, so the DorkOS server (discovery, the
 * lifecycle and the capability registry's `contribute`) and `dorkos
 * marketplace validate` all run the same code and reach the same answer.
 *
 * - {@link checkToolInputSchema}: the closed JSON Schema subset an input may
 *   use, converted with Zod's `fromJSONSchema`. An open object,
 *   `patternProperties`, `propertyNames` and `$ref` each convert to a record
 *   (or a cycle), and one record anywhere in any in-session tool empties the
 *   whole `dorkos` tool list on the current Claude SDK.
 * - {@link checkContributionShape}: the id, display name and per-tool rules
 *   (name, one-line title, tier, card fields, a schema every tool list can
 *   render).
 * - {@link checkDeclaredTools}: both, for every tool a manifest declares.
 *
 * @module @dorkos/extension-api/tool-check
 */
import { z } from 'zod';
import {
  CAPABILITY_TIERS,
  EXTENSION_MCP_TOOL_NAME_MAX,
  EXTENSION_TOOL_NAME_PATTERN,
  EXTENSION_TOOL_TITLE_MAX,
  extensionMcpToolName,
  isSecretInputKey,
  type CapabilityTier,
} from '@dorkos/shared/capabilities';
import { EXTENSION_ID_REGEX } from '@dorkos/shared/extension-id';
import { portableInputShape } from '@dorkos/shared/portable-input-shape';

import {
  EXTENSION_TOOL_TIMEOUT_DEFAULT_SECONDS,
  EXTENSION_TOOL_TIMEOUT_MAX_SECONDS,
  type ExtensionManifest,
} from './manifest-schema.js';
import type { ExtensionToolCheckSummary } from './types.js';

/** The longest extension display name, shown beside every one of its tools. */
export const EXTENSION_DISPLAY_NAME_MAX = 40;

/**
 * Names an extension may not call itself, compared after lowercasing and
 * dropping everything but letters and digits: a row or card reading "From
 * DorkOS" would claim the tool is DorkOS's own.
 */
const RESERVED_DISPLAY_NAMES: ReadonlySet<string> = new Set(['dorkos', 'dorkbot']);

/** One tool's checked fields, everything an author decides except its handler. */
export interface CheckedToolFields {
  /** The tool's name inside its extension. */
  name: string;
  /** Human-facing title: one line, no quote marks. */
  title: string;
  /** Model-facing description. */
  description: string;
  /** Permission tier. */
  tier: CapabilityTier;
  /** The input contract, a closed Zod object. */
  input: z.ZodObject;
  /** Top-level input keys the approval card shows. */
  approvalDisplayFields?: readonly string[];
}

/** A contribution after {@link checkContributionShape}. */
export interface CheckedContribution<T> {
  /** The extension's id. */
  owner: string;
  /** Its display name. */
  displayName: string;
  /** Its tools, each with what `readExtra` read. */
  tools: ReadonlyArray<CheckedToolFields & { extra: T }>;
}

/** Reads and checks one more field of a tool, once. */
export type ReadExtra<T> = (spec: Record<string, unknown>, name: string) => Checked<T>;

/** For a check with nothing more to read. */
const NO_EXTRA: ReadExtra<undefined> = () => ({ ok: true, value: undefined });

/** Either a usable value or the sentence saying why it was refused. */
export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Characters author text on a card may not contain: the straight double quote
 * and every typographic quote mark (`“ ” „ ‟ ‘ ’ ‚ ‛ « » ‹ ›`, CJK and
 * full-width quotes), C0/C1 controls (`\p{Cc}`), the line and paragraph separators, and
 * every format character (`\p{Cf}`).
 */
const CARD_TEXT_REFUSED =
  /["\p{Cc}\u00ab\u00bb\u2018-\u201f\u2039\u203a\u2028\u2029\u300c-\u300f\u301d-\u301f\uff02\uff07\p{Cf}]/u;

/**
 * Whether a display name contains a letter outside ASCII, after NFKC folds
 * compatibility forms (full-width letters, ligatures) to their plain letters.
 * Refused because a look-alike letter — a Cyrillic `о` in "DоrkOS" — would let
 * a name read as one the reserved-name check refuses.
 */
function hasNonAsciiLetter(value: string): boolean {
  return /[^\p{ASCII}]/u.test(value.normalize('NFKC').replace(/[^\p{L}]/gu, ''));
}

/** Whether a value is a non-empty string after trimming. */
function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Whether author text is safe to put on a card: a non-empty single line within
 * `max` characters, with no quote mark, no control character and no invisible
 * format character. A quote, straight or typographic, could close (or look as
 * if it closed) the card's quoted title and forge a field after it; a newline
 * or control character could fake a second line; a format character (Unicode
 * category Cf: zero-width spaces, bidi overrides and isolates, the BOM, soft
 * hyphens) can hide text or reorder what a person reads.
 */
function isCardText(value: unknown, max: number): value is string {
  return (
    isText(value) && value.length <= max && value === value.trim() && !CARD_TEXT_REFUSED.test(value)
  );
}

/**
 * Find the first JSON Schema construct an agent tool list cannot carry.
 *
 * `propertyNames` is what `z.record` (and `z.json`) render to, and a record
 * anywhere in any in-session tool's input empties the whole `dorkos` tool list
 * on the current Claude SDK (`tool-exposure.ts`). `$ref` and `patternProperties`
 * come from the same family, and an `additionalProperties` that is anything but
 * `false` is an open map (catchall, loose) the spec refuses as well (§2).
 *
 * @returns The offending keyword, or `undefined` when the schema is closed.
 */
function openSchemaKeyword(node: unknown): string | undefined {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = openSchemaKeyword(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!node || typeof node !== 'object') return undefined;
  const record = node as Record<string, unknown>;
  for (const keyword of ['propertyNames', 'patternProperties', '$ref', '$defs']) {
    if (keyword in record) return keyword;
  }
  if ('additionalProperties' in record && record.additionalProperties !== false) {
    return 'additionalProperties';
  }
  for (const value of Object.values(record)) {
    const found = openSchemaKeyword(value);
    if (found) return found;
  }
  return undefined;
}

/**
 * The first open-ended or self-referencing schema anywhere inside `schema`:
 * a `z.record` (which one tool would use to empty the whole `dorkos` tool list
 * on the current Claude SDK, `tool-exposure.ts`) or a `z.lazy`. Walks the Zod
 * tree itself rather than its JSON rendering, so a record the renderer happened
 * to spell some other way is still found.
 *
 * @returns `record` or `lazy`, or `undefined` when there is neither.
 */
function openZodNode(schema: unknown, seen = new Set<unknown>()): string | undefined {
  if (!schema || typeof schema !== 'object' || seen.has(schema)) return undefined;
  seen.add(schema);
  if (schema instanceof z.ZodRecord) return 'record';
  if (schema instanceof z.ZodLazy) return 'lazy';
  const def = (schema as { _zod?: { def?: unknown } })._zod?.def;
  const children: unknown[] = [];
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') {
      if ('_zod' in value) children.push(value);
      else if (Object.getPrototypeOf(value) === Object.prototype) {
        Object.values(value).forEach(collect);
      }
    }
  };
  if (def && typeof def === 'object') Object.values(def).forEach(collect);
  for (const child of children) {
    const found = openZodNode(child, seen);
    if (found) return found;
  }
  return undefined;
}

/**
 * Check that an input schema renders as closed JSON Schema, and that the exact
 * field map an agent tool list advertises renders too.
 *
 * Rendering here, once, is what keeps one tool from breaking everyone else's:
 * the catalog renders every capability's schema on every read, and an
 * unrepresentable type (`z.date()`, a `.transform()`) throws there. The second
 * rendering is of the field map the MCP projection hands a tool list
 * ({@link portableInputShape}), so a schema accepted here is one the in-session
 * server can list.
 *
 * The one implementation for every caller: the registry runs it at contribute
 * time, and discovery and `dorkos marketplace validate` run it (through
 * {@link checkDeclaredTools}) on every tool an `extension.json` declares, so a
 * manifest that loads names no tool `contribute` would refuse.
 */
function checkSchema(name: string, input: z.ZodObject): string | undefined {
  let rendered: unknown;
  try {
    rendered = z.toJSONSchema(input);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return `tool "${name}" input cannot be written as JSON Schema: ${why}`;
  }
  const keyword = openSchemaKeyword(rendered);
  if (keyword) return `tool "${name}" input uses ${keyword}, which agent tool lists cannot carry`;
  const node = openZodNode(input);
  if (node)
    return `tool "${name}" input uses a ${node} schema, which agent tool lists cannot carry`;
  try {
    z.toJSONSchema(z.object(portableInputShape(input.shape)));
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return `tool "${name}" input can't be listed: ${why}`;
  }
  return undefined;
}

/**
 * Read one tool spec into a fresh plain object, checking every field once.
 *
 * Reading each field exactly once matters: a contribution is author-supplied,
 * and a getter that answered one way to the check and another way to the build
 * would otherwise slip past the check.
 */
function checkTool<T>(
  raw: unknown,
  index: number,
  readExtra: ReadExtra<T>
): Checked<CheckedToolFields & { extra: T }> {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: `tool ${index + 1} is not an object` };
  }
  const spec = raw as Record<string, unknown>;
  const name = spec.name;
  const title = spec.title;
  const description = spec.description;
  const tier = spec.tier;
  const input = spec.input;
  const displayFields = spec.approvalDisplayFields;

  if (typeof name !== 'string' || !EXTENSION_TOOL_NAME_PATTERN.test(name)) {
    return { ok: false, reason: `tool ${index + 1} has an invalid name` };
  }
  if (!isCardText(title, EXTENSION_TOOL_TITLE_MAX)) {
    return {
      ok: false,
      reason: `tool "${name}" title must be one line of at most ${EXTENSION_TOOL_TITLE_MAX} characters, with no quotes`,
    };
  }
  if (!isText(description)) return { ok: false, reason: `tool "${name}" has no description` };
  if (typeof tier !== 'string' || !(CAPABILITY_TIERS as readonly string[]).includes(tier)) {
    return { ok: false, reason: `tool "${name}" has an unknown tier` };
  }
  if (!(input instanceof z.ZodObject)) {
    return { ok: false, reason: `tool "${name}" input is not an object schema` };
  }
  const schemaProblem = checkSchema(name, input);
  if (schemaProblem) return { ok: false, reason: schemaProblem };
  const extra = readExtra(spec, name);
  if (!extra.ok) return extra;

  const keys = Object.keys(input.shape);
  let fields: readonly string[] | undefined;
  if (displayFields !== undefined) {
    if (!Array.isArray(displayFields)) {
      return { ok: false, reason: `tool "${name}" display fields are not a list` };
    }
    const copy = [...(displayFields as unknown[])];
    for (const field of copy) {
      if (typeof field !== 'string' || !keys.includes(field)) {
        return { ok: false, reason: `tool "${name}" shows a field its input does not have` };
      }
      // A display field reaches the broadcast approval card and the
      // agent-readable pending list, so one named like a secret is refused
      // here exactly as conformance refuses it on a core capability.
      if (isSecretInputKey(field)) {
        return { ok: false, reason: `tool "${name}" shows a secret field on its card` };
      }
    }
    fields = Object.freeze(copy as string[]);
  }
  // The same rule capability conformance holds core actions to: anything that
  // can raise a card says what the card shows, and a destructive card always
  // shows something. Only an `act` tool that takes no arguments may show none.
  if (tier !== 'observe') {
    if (!fields) {
      return { ok: false, reason: `tool "${name}" must say which fields its approval card shows` };
    }
    if (fields.length === 0 && (tier === 'destructive' || keys.length > 0)) {
      return { ok: false, reason: `tool "${name}" approval card would show none of its fields` };
    }
  }

  return {
    ok: true,
    value: {
      name,
      title,
      description,
      tier: tier as CapabilityTier,
      input,
      ...(fields ? { approvalDisplayFields: fields } : {}),
      extra: extra.value,
    },
  };
}

/**
 * Check what an extension asks to give agents — its id, display name and tool
 * fields — and copy it into a fresh, frozen plain value. The one
 * implementation of these rules: the server's `registry.contribute` runs it
 * (reading each tool's handler through `readExtra`), and so do discovery and
 * `dorkos marketplace validate` (through {@link checkDeclaredTools}), so a tool
 * that passes one is accepted by the others.
 *
 * Never throws: anything wrong, including a field that throws when read, comes
 * back as a refusal sentence.
 *
 * @param contribution - `{ owner, displayName, tools }`, as the author supplied it.
 * @param readExtra - Reads and checks one more field of each tool (the
 *   server's handler), once, right after the input schema passes.
 * @returns The checked copy, or the reason it was refused.
 */
export function checkContributionShape<T>(
  contribution: unknown,
  readExtra: ReadExtra<T>
): Checked<CheckedContribution<T>> {
  try {
    if (!contribution || typeof contribution !== 'object') {
      return { ok: false, reason: 'the contribution is not an object' };
    }
    const raw = contribution as Record<string, unknown>;
    const owner = raw.owner;
    const displayName = raw.displayName;
    const tools = raw.tools;
    // `--` or a trailing `-` would put `__` in, or `_` at the end of, the
    // domain, and the MCP name `ext_<id>__<tool>` could then be read two ways.
    if (
      typeof owner !== 'string' ||
      !EXTENSION_ID_REGEX.test(owner) ||
      owner.includes('--') ||
      owner.endsWith('-')
    ) {
      return { ok: false, reason: 'the extension id is invalid' };
    }
    if (!isCardText(displayName, EXTENSION_DISPLAY_NAME_MAX)) {
      return {
        ok: false,
        reason: `${owner} display name must be one line of at most ${EXTENSION_DISPLAY_NAME_MAX} characters, with no quotes`,
      };
    }
    if (hasNonAsciiLetter(displayName)) {
      return { ok: false, reason: `${owner} display name must use plain letters A to Z` };
    }
    if (
      RESERVED_DISPLAY_NAMES.has(
        displayName
          .normalize('NFKC')
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '')
      )
    ) {
      return { ok: false, reason: `${owner} may not call itself ${displayName}` };
    }
    if (!Array.isArray(tools) || tools.length === 0) {
      return { ok: false, reason: `${displayName} contributes no tools` };
    }
    const checked: Array<CheckedToolFields & { extra: T }> = [];
    const names = new Set<string>();
    for (const [index, tool] of [...(tools as unknown[])].entries()) {
      const result = checkTool(tool, index, readExtra);
      if (!result.ok) return { ok: false, reason: `${displayName}: ${result.reason}` };
      if (names.has(result.value.name)) {
        return { ok: false, reason: `${displayName} declares "${result.value.name}" twice` };
      }
      const toolName = extensionMcpToolName(owner, result.value.name);
      if (toolName.length > EXTENSION_MCP_TOOL_NAME_MAX) {
        return {
          ok: false,
          reason: `${displayName}: tool "${result.value.name}" makes the name ${toolName}, longer than ${EXTENSION_MCP_TOOL_NAME_MAX} characters`,
        };
      }
      names.add(result.value.name);
      checked.push(result.value);
    }
    return {
      ok: true,
      value: Object.freeze({ owner, displayName, tools: Object.freeze(checked) }),
    };
  } catch (err) {
    return {
      ok: false,
      reason: `the contribution could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

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

/** One declared tool DorkOS accepted, ready to bind a handler to. */
export interface AcceptedExtensionTool {
  /** The tool's name inside its extension. */
  name: string;
  /** The title a person reads. */
  title: string;
  /** What the tool does, for the agent. */
  description: string;
  /** Its permission tier. */
  tier: CapabilityTier;
  /** The converted input schema the registry parses calls against. */
  input: z.ZodObject;
  /** Input fields its approval card shows. */
  approvalDisplayFields?: readonly string[];
  /** How long one call may run, in seconds, already capped. */
  timeoutSeconds: number;
}

/** What DorkOS decided about one declared tool. */
export type ExtensionToolCheck =
  | ({ ok: true } & AcceptedExtensionTool)
  | { ok: false; name: string; title: string; tier: CapabilityTier; reason: string };

/**
 * Decide which of a manifest's declared tools DorkOS accepts.
 *
 * Deterministic and side-effect free, so discovery (to report), the server
 * lifecycle (to bind) and `dorkos marketplace validate` all call it on the same
 * manifest and get the same answer.
 *
 * @param manifest - A manifest that already passed `ExtensionManifestSchema`.
 * @returns One decision per declared tool, in declaration order.
 */
export function checkDeclaredTools(manifest: ExtensionManifest): ExtensionToolCheck[] {
  return (manifest.tools ?? []).map((tool): ExtensionToolCheck => {
    const refused = (reason: string): ExtensionToolCheck => ({
      ok: false,
      name: tool.name,
      title: tool.title,
      tier: tool.tier,
      reason: plainReason(reason),
    });
    const schema = checkToolInputSchema(tool.inputSchema);
    if (!schema.ok) return refused(schema.reason);
    // The registry's own check, on this one tool. Checked alone so one bad
    // tool never takes its siblings down with it.
    const checked = checkContributionShape(
      {
        owner: manifest.id,
        displayName: manifest.name,
        tools: [
          {
            name: tool.name,
            title: tool.title,
            description: tool.description,
            tier: tool.tier,
            input: schema.zod,
            ...(tool.approvalDisplayFields
              ? { approvalDisplayFields: tool.approvalDisplayFields }
              : {}),
          },
        ],
      },
      NO_EXTRA
    );
    if (!checked.ok) return refused(checked.reason);
    const timeout = Math.min(
      Math.max(1, Math.trunc(tool.timeoutSeconds ?? EXTENSION_TOOL_TIMEOUT_DEFAULT_SECONDS)),
      EXTENSION_TOOL_TIMEOUT_MAX_SECONDS
    );
    return {
      ok: true,
      name: tool.name,
      title: tool.title,
      description: tool.description,
      tier: tool.tier,
      input: schema.zod,
      ...(tool.approvalDisplayFields
        ? { approvalDisplayFields: Object.freeze([...tool.approvalDisplayFields]) }
        : {}),
      timeoutSeconds: Number.isFinite(timeout) ? timeout : EXTENSION_TOOL_TIMEOUT_DEFAULT_SECONDS,
    };
  });
}

/**
 * The plain-data summary of one decision, for the discovery record and the
 * public record (no Zod schema, no handler).
 *
 * @param check - One entry from {@link checkDeclaredTools}.
 */
export function summarizeToolCheck(check: ExtensionToolCheck): ExtensionToolCheckSummary {
  return check.ok
    ? { name: check.name, title: check.title, tier: check.tier, ok: true }
    : { name: check.name, title: check.title, tier: check.tier, ok: false, reason: check.reason };
}
