/**
 * The user config's SHAPE: every path in `UserConfigSchema`, with the values
 * it accepts, as a flat map a PR can diff against its base.
 *
 * Read from the JSON Schema conf validates against (`z.toJSONSchema`), so the
 * shape is what Ajv sees, not what the Zod source looks like: a comment, a
 * reworded `.describe()` or a moved declaration changes nothing here. Defaults
 * are recorded as present or absent, never by value, so changing a default is
 * not a shape change either. Bounds, lengths, patterns and formats are kept
 * (`where {...}`), so a tightened limit reads as a narrowing.
 *
 * A path is a dot-path from the root; `[]` steps into an array's elements and
 * `*` into a record's values. Each path maps to a signature:
 *
 *   `boolean`                    a required boolean, no default
 *   `string | null (default)`    a nullable string with a default
 *   `"dark" | "light"`           an enum, its values as JSON
 *   `number | undefined`         optional, no default: a file may leave it out
 *   `integer where {"maximum":65535} (default)`   with its constraints
 *   `object` / `array`           a container; its members are their own paths
 *
 * A member of a union of objects (`oneOf` variants) is optional only when a
 * branch that declares it leaves it optional: a member only one variant has is
 * as required as that variant says, since stored elements of that variant
 * must carry it.
 *
 * @module scripts/config-migration/shape
 */

/** Path to signature, sorted by path. */
export type ConfigShape = Record<string, string>;

/** A signature, parsed. */
export interface Signature {
  /** Type names (`string`, `object`, ...) and JSON literals (`"dark"`, `1`), sorted. */
  atoms: string[];
  /** The schema gives a default, so a file may leave it out. */
  hasDefault: boolean;
  /** Constraint keywords (`maximum`, `pattern`, ...) to their values. */
  constraints: Record<string, unknown>;
}

const DEFAULT_SUFFIX = ' (default)';
const ABSENT = 'undefined';
const ANY = 'any';
const WHERE = ' where ';
const UNSUPPORTED = [
  '$ref',
  'allOf',
  'not',
  'prefixItems',
  'if',
  'patternProperties',
  'dependentRequired',
  'dependentSchemas',
  'contains',
  'unevaluatedProperties',
  'unevaluatedItems',
];
/** Bounds that refuse more as they rise, and that refuse more as they fall. */
const LOWER_BOUNDS = ['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties'];
const UPPER_BOUNDS = ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties'];
/** Every constraint kept; any change to one of the last five reads as a narrowing. */
const CONSTRAINTS = [
  ...LOWER_BOUNDS,
  ...UPPER_BOUNDS,
  'multipleOf',
  'pattern',
  'format',
  'uniqueItems',
  'propertyNames',
];

type Node = Record<string, unknown>;
interface Entry {
  atoms: Set<string>;
  hasDefault: boolean;
  absent: boolean;
  constraints: Map<string, unknown[]>;
}

function asNode(value: unknown, path: string): Node {
  if (value === true || value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${path || '(root)'}: not a JSON Schema node`);
  const node = value as Node;
  const unsupported = UNSUPPORTED.find((key) => key in node);
  if (unsupported)
    throw new Error(
      `${path || '(root)'}: uses "${unsupported}", which this shape walk does not follow. Teach scripts/config-migration/shape.ts the shape before relying on the check.`
    );
  return node;
}

function record(
  acc: Map<string, Entry>,
  path: string,
  atoms: string[],
  node: Node,
  absent: boolean
) {
  const entry = acc.get(path) ?? {
    atoms: new Set<string>(),
    hasDefault: false,
    absent: false,
    constraints: new Map<string, unknown[]>(),
  };
  for (const atom of atoms) entry.atoms.add(atom);
  entry.hasDefault ||= 'default' in node;
  entry.absent ||= absent;
  for (const key of CONSTRAINTS)
    if (key in node) entry.constraints.set(key, [...(entry.constraints.get(key) ?? []), node[key]]);
  acc.set(path, entry);
}

function walk(value: unknown, path: string, acc: Map<string, Entry>, absent: boolean): void {
  const node = asNode(value, path);
  const branches = node.anyOf ?? node.oneOf;
  if (Array.isArray(branches)) {
    // Every branch records into the same paths: their values join, and a
    // member is optional when any branch that declares it says so.
    for (const branch of branches) walk(branch, path, acc, absent);
    record(acc, path, [], node, absent);
    return;
  }

  if ('const' in node) return record(acc, path, [JSON.stringify(node.const)], node, absent);
  if (Array.isArray(node.enum))
    return record(
      acc,
      path,
      node.enum.map((item) => JSON.stringify(item)),
      node,
      absent
    );

  const types = Array.isArray(node.type) ? node.type : node.type === undefined ? [] : [node.type];
  const isObject = types.includes('object') || 'properties' in node;
  const isArray = types.includes('array') || 'items' in node;
  const scalars = types.filter(
    (type): type is string => typeof type === 'string' && type !== 'object' && type !== 'array'
  );
  // An untyped node (`z.unknown()`) accepts anything, and says so.
  const any = !isObject && !isArray && scalars.length === 0 ? [ANY] : [];
  record(
    acc,
    path,
    [...any, ...scalars, ...(isObject ? ['object'] : []), ...(isArray ? ['array'] : [])],
    node,
    absent
  );

  if (isObject) {
    const required = new Set(Array.isArray(node.required) ? node.required : []);
    const properties = (node.properties ?? {}) as Record<string, unknown>;
    for (const [key, child] of Object.entries(properties))
      walk(child, path ? `${path}.${key}` : key, acc, !required.has(key));
    const extra = node.additionalProperties;
    if (extra !== undefined && extra !== false) walk(extra, `${path}.*`, acc, true);
  }
  if (isArray) walk(node.items, `${path}[]`, acc, false);
}

/**
 * Reduce a generated JSON Schema to its {@link ConfigShape}. Throws on a
 * keyword it does not follow (a `$ref`, an `allOf`, `patternProperties`),
 * because a shape that silently skipped part of the schema would let that part
 * change unchecked. An untyped node (`z.unknown()`) is recorded as `any`.
 */
export function shapeOf(jsonSchema: unknown): ConfigShape {
  const acc = new Map<string, Entry>();
  walk(jsonSchema, '', acc, false);
  acc.delete('');
  const shape: ConfigShape = {};
  for (const path of [...acc.keys()].sort()) {
    const entry = acc.get(path)!;
    const atoms = [...entry.atoms];
    if (entry.absent && !entry.hasDefault) atoms.push(ABSENT);
    shape[path] = formatSignature({
      atoms: normalize(atoms),
      hasDefault: entry.hasDefault,
      constraints: mergeConstraints(entry.constraints),
    });
  }
  return shape;
}

/**
 * One value per constraint, the loosest when union branches disagree on a
 * bound; other keywords keep every distinct value, so any change shows.
 */
function mergeConstraints(found: Map<string, unknown[]>): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const key of [...found.keys()].sort()) {
    const values = found.get(key)!;
    if (LOWER_BOUNDS.includes(key)) merged[key] = Math.min(...(values as number[]));
    else if (UPPER_BOUNDS.includes(key)) merged[key] = Math.max(...(values as number[]));
    else {
      const distinct = [...new Set(values.map((value) => JSON.stringify(value)))].sort();
      merged[key] =
        distinct.length === 1 ? values[0] : distinct.map((text) => JSON.parse(text) as unknown);
    }
  }
  return merged;
}

/** Drop a literal its own type already covers, and sort. */
function normalize(atoms: string[]): string[] {
  const set = new Set(atoms);
  for (const atom of set) if (isLiteral(atom) && set.has(literalType(atom))) set.delete(atom);
  return [...set].sort();
}

/** The signature as stored in the shape file. */
export function formatSignature(signature: Signature): string {
  const where = Object.keys(signature.constraints).length
    ? `${WHERE}${JSON.stringify(signature.constraints)}`
    : '';
  return signature.atoms.join(' | ') + where + (signature.hasDefault ? DEFAULT_SUFFIX : '');
}

/** Parse a stored signature back; JSON string literals may hold any character. */
export function parseSignature(text: string): Signature {
  const hasDefault = text.endsWith(DEFAULT_SUFFIX);
  let body = hasDefault ? text.slice(0, -DEFAULT_SUFFIX.length) : text;
  let constraints: Record<string, unknown> = {};
  // The first ` where {` whose rest is a JSON object; a literal may hold the words.
  for (let at = body.indexOf(`${WHERE}{`); at !== -1; at = body.indexOf(`${WHERE}{`, at + 1)) {
    try {
      constraints = JSON.parse(body.slice(at + WHERE.length)) as Record<string, unknown>;
      body = body.slice(0, at);
      break;
    } catch {
      // Not the constraints yet; keep looking.
    }
  }
  return { atoms: body.match(/"(?:[^"\\]|\\.)*"|[^\s|]+/g) ?? [], hasDefault, constraints };
}

function isLiteral(atom: string): boolean {
  return /^["\d-]/.test(atom) || atom === 'true' || atom === 'false';
}

function literalType(atom: string): string {
  if (atom.startsWith('"')) return 'string';
  if (atom === 'true' || atom === 'false') return 'boolean';
  return Number.isInteger(Number(atom)) ? 'integer' : 'number';
}

/**
 * Whether every value `before` accepts, `after` accepts too: the change only
 * widened the field (a new enum value, `string` to `string | null`, optional
 * where it was required, a raised maximum, a dropped pattern), so no stored
 * value stops fitting.
 */
export function onlyWidened(before: string, after: string): boolean {
  const was = parseSignature(before);
  const now = parseSignature(after);
  const has = new Set(now.atoms);
  if (has.has(ANY)) return true;
  const acceptsAbsent = now.hasDefault || has.has(ABSENT);
  if (was.hasDefault && !acceptsAbsent) return false;
  const accepts = (atom: string): boolean => {
    if (has.has(atom)) return true;
    if (atom === ABSENT) return acceptsAbsent;
    if (atom === 'integer') return has.has('number');
    if (isLiteral(atom)) return accepts(literalType(atom));
    return false;
  };
  return was.atoms.every(accepts) && onlyLoosened(was.constraints, now.constraints);
}

/** No constraint was added, tightened or (for a pattern, format and the like) changed. */
function onlyLoosened(was: Record<string, unknown>, now: Record<string, unknown>): boolean {
  return Object.entries(now).every(([key, value]) => {
    if (!(key in was)) return false;
    const old = was[key];
    if (LOWER_BOUNDS.includes(key)) return (value as number) <= (old as number);
    if (UPPER_BOUNDS.includes(key)) return (value as number) >= (old as number);
    return JSON.stringify(value) === JSON.stringify(old);
  });
}

/** Whether a stored file may leave the path out: it has a default, or it is optional. */
export function acceptsAbsent(signature: string): boolean {
  const parsed = parseSignature(signature);
  return parsed.hasDefault || parsed.atoms.includes(ABSENT);
}

/** Whether a stored file may leave the path out with nothing filling it in. */
export function isOptionalWithoutDefault(signature: string): boolean {
  const parsed = parseSignature(signature);
  return !parsed.hasDefault && parsed.atoms.includes(ABSENT);
}
