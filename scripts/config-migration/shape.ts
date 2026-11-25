/**
 * The user config's SHAPE: every path in `UserConfigSchema`, with the values
 * it accepts, as a flat map a PR can diff against its base.
 *
 * Read from the JSON Schema conf validates against (`z.toJSONSchema`), so the
 * shape is what Ajv sees, not what the Zod source looks like: a comment, a
 * reworded `.describe()` or a moved declaration changes nothing here. Defaults
 * are recorded as present or absent, never by value, so changing a default is
 * not a shape change either.
 *
 * A path is a dot-path from the root; `[]` steps into an array's elements and
 * `*` into a record's values. Each path maps to a signature:
 *
 *   `boolean`                    a required boolean, no default
 *   `string | null (default)`    a nullable string with a default
 *   `"dark" | "light"`           an enum, its values as JSON
 *   `number | undefined`         optional, no default: a file may leave it out
 *   `object` / `array`           a container; its members are their own paths
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
}

const DEFAULT_SUFFIX = ' (default)';
const ABSENT = 'undefined';
const ANY = 'any';
const UNSUPPORTED = ['$ref', 'allOf', 'not', 'prefixItems', 'if', 'patternProperties'];

type Node = Record<string, unknown>;
interface Entry {
  atoms: Set<string>;
  hasDefault: boolean;
  absent: boolean;
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
  const entry = acc.get(path) ?? { atoms: new Set<string>(), hasDefault: false, absent: false };
  for (const atom of atoms) entry.atoms.add(atom);
  entry.hasDefault ||= 'default' in node;
  entry.absent ||= absent;
  acc.set(path, entry);
}

function walk(value: unknown, path: string, acc: Map<string, Entry>, absent: boolean): void {
  const node = asNode(value, path);
  const branches = node.anyOf ?? node.oneOf;
  if (Array.isArray(branches)) {
    // Walk each branch on its own, so a member only some object branches
    // declare can be marked as one a file may leave out.
    const perBranch = branches.map((branch) => {
      const own = new Map<string, Entry>();
      walk(branch, path, own, absent);
      return own;
    });
    const objectBranches = perBranch.filter((own) => own.get(path)?.atoms.has('object'));
    for (const own of perBranch)
      for (const [child, entry] of own) {
        const partial = child !== path && objectBranches.some((other) => !other.has(child));
        const merged = acc.get(child) ?? { atoms: new Set(), hasDefault: false, absent: false };
        for (const atom of entry.atoms) merged.atoms.add(atom);
        merged.hasDefault ||= entry.hasDefault;
        merged.absent ||= entry.absent || partial;
        acc.set(child, merged);
      }
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
 * Reduce a generated JSON Schema to its {@link ConfigShape}. Throws on a node
 * it cannot name (a `$ref`, an `allOf`, an untyped node), because a shape that
 * silently skipped part of the schema would let that part change unchecked.
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
    shape[path] = formatSignature({ atoms: normalize(atoms), hasDefault: entry.hasDefault });
  }
  return shape;
}

/** Drop a literal its own type already covers, and sort. */
function normalize(atoms: string[]): string[] {
  const set = new Set(atoms);
  for (const atom of set) if (isLiteral(atom) && set.has(literalType(atom))) set.delete(atom);
  return [...set].sort();
}

/** The signature as stored in the shape file. */
export function formatSignature(signature: Signature): string {
  return signature.atoms.join(' | ') + (signature.hasDefault ? DEFAULT_SUFFIX : '');
}

/** Parse a stored signature back; JSON string literals may hold any character. */
export function parseSignature(text: string): Signature {
  const hasDefault = text.endsWith(DEFAULT_SUFFIX);
  const body = hasDefault ? text.slice(0, -DEFAULT_SUFFIX.length) : text;
  return { atoms: body.match(/"(?:[^"\\]|\\.)*"|[^\s|]+/g) ?? [], hasDefault };
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
 * where it was required), so no stored value stops fitting.
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
  return was.atoms.every(accepts);
}

/** Whether a stored file may leave the path out with nothing filling it in. */
export function isOptionalWithoutDefault(signature: string): boolean {
  const parsed = parseSignature(signature);
  return !parsed.hasDefault && parsed.atoms.includes(ABSENT);
}
