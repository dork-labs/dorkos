/**
 * The walk that lists every leaf of the user config schema and says what each one
 * reduces to. `config-disclosure.ts` classifies those leaves, and its drift guards
 * compare against this list.
 *
 * @module services/core/operator/config-schema-leaves
 */
import { z } from 'zod';
import { UserConfigSchema } from '@dorkos/shared/config-schema';

/**
 * What a JSON-Schema node reduces to once the walk stops guessing.
 *
 * - `scalar` — a primitive, or a union of primitives (`z.string().nullable()`).
 * - `scalar-array` — an array whose element schema is a primitive.
 * - `record` — an open map (`z.record`) whose value schema is a primitive. Safe
 *   to disclose whole only when listed in `EXPOSED_RECORD_PATHS`.
 * - `unsupported` — the walk could not prove any of the above: a record of
 *   objects, an untyped node, a `$ref`, an `allOf`, a tuple, or a union whose
 *   branches disagree. Never disclosable without teaching the walker first.
 */
export type SchemaLeafShape = 'scalar' | 'scalar-array' | 'record' | 'unsupported';

/** One classified leaf of a JSON Schema: where it lives, and what it is. */
export interface SchemaLeaf {
  /** Dot-path from the schema root; `[]` marks a descent into array elements. */
  path: string;
  /** What the node reduces to. */
  shape: SchemaLeafShape;
}

/** JSON-Schema primitive type names, the ones that end a walk. */
const SCALAR_JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null']);

/** A JSON-Schema node, read structurally rather than through a typed model. */
type JsonSchemaNode = Record<string, unknown>;

/** Narrow an unknown to a plain JSON-Schema object node. */
function asSchemaNode(node: unknown): JsonSchemaNode | undefined {
  return node !== null && typeof node === 'object' && !Array.isArray(node)
    ? (node as JsonSchemaNode)
    : undefined;
}

/** The `anyOf` / `oneOf` branches of a node, if it is a union. */
function unionBranches(node: JsonSchemaNode): JsonSchemaNode[] | undefined {
  const branches = node.anyOf ?? node.oneOf;
  if (!Array.isArray(branches)) return undefined;
  return branches.map((branch) => asSchemaNode(branch) ?? {});
}

/** Whether a node is a primitive, or a union of primitives. */
function isScalarSchema(node: unknown): boolean {
  const schema = asSchemaNode(node);
  if (!schema) return false;
  if ('$ref' in schema || 'allOf' in schema || 'properties' in schema || 'items' in schema) {
    return false;
  }
  const branches = unionBranches(schema);
  if (branches) return branches.every(isScalarSchema);
  const type = schema.type;
  if (typeof type === 'string') return SCALAR_JSON_TYPES.has(type);
  if (Array.isArray(type)) {
    return type.every((entry) => typeof entry === 'string' && SCALAR_JSON_TYPES.has(entry));
  }
  return false;
}

/** Whether a union branch is the `null` half of a nullable. */
function isNullSchema(node: JsonSchemaNode): boolean {
  return node.type === 'null';
}

/**
 * Merge leaves from several union branches: same path twice is fine while the
 * shapes agree, and becomes `unsupported` when they do not, because a caller
 * cannot be told which one it will get.
 */
function mergeLeaves(leaves: SchemaLeaf[]): SchemaLeaf[] {
  const byPath = new Map<string, SchemaLeafShape>();
  for (const { path, shape } of leaves) {
    const seen = byPath.get(path);
    byPath.set(path, seen === undefined || seen === shape ? shape : 'unsupported');
  }
  return [...byPath].map(([path, shape]) => ({ path, shape }));
}

/**
 * Classify every leaf of a JSON Schema, asserting leaf-ness instead of inferring
 * it from a missing `properties` map.
 *
 * The walk descends into objects, into array `items` (appending `[]` to the
 * path), and into every non-null `anyOf` / `oneOf` branch, so a field nested
 * inside an array element or behind a nullable object branch is enumerated in its
 * own right. Anything it cannot reduce to a scalar, an array of scalars, or a
 * record of scalars is reported `unsupported` rather than waved through, which is
 * what stops a subtree from being disclosed on an ancestor's verdict.
 *
 * Exported separately from {@link configSchemaLeaves} so the guard can exercise
 * shapes the live config schema does not currently contain.
 *
 * @param root - A generated JSON Schema node (the walk never follows `$ref`).
 * @param path - Dot-path of `root`; defaults to the schema root.
 * @returns The classified leaves, in schema order.
 */
export function classifySchemaLeaves(root: unknown, path = ''): SchemaLeaf[] {
  const node = asSchemaNode(root);
  if (!node) return [{ path, shape: 'unsupported' }];

  // Indirection the walk deliberately does not follow: resolving it would mean
  // reimplementing a JSON-Schema resolver to decide a security question.
  if ('$ref' in node || 'allOf' in node) return [{ path, shape: 'unsupported' }];

  const branches = unionBranches(node);
  if (branches) {
    const meaningful = branches.filter((branch) => !isNullSchema(branch));
    if (meaningful.length === 0) return [{ path, shape: 'scalar' }];
    const perBranch = meaningful.map((branch) => classifySchemaLeaves(branch, path));
    // Every branch ends at this path (the nullable-scalar case, and unions of
    // primitives): one leaf, agreeing shape or `unsupported`.
    if (perBranch.every((leaves) => leaves.length === 1 && leaves[0]!.path === path)) {
      return mergeLeaves(perBranch.flat());
    }
    // Some branches end here and others open a subtree, so no single verdict can
    // describe what a caller receives. Refuse rather than classify half of it.
    if (perBranch.some((leaves) => leaves.some((leaf) => leaf.path === path))) {
      return [{ path, shape: 'unsupported' }];
    }
    return mergeLeaves(perBranch.flat());
  }

  const properties = asSchemaNode(node.properties);
  const additional = node.additionalProperties;
  const isOpen = additional !== undefined && additional !== false;

  if (properties) {
    // A named shape plus an open catchall: the catchall's contents have no path
    // to classify, so refuse rather than disclose the half we can see.
    if (isOpen) return [{ path, shape: 'unsupported' }];
    return Object.entries(properties).flatMap(([key, child]) =>
      classifySchemaLeaves(child, path ? `${path}.${key}` : key)
    );
  }

  if (isOpen) return [{ path, shape: isScalarSchema(additional) ? 'record' : 'unsupported' }];

  if (node.type === 'array' || 'items' in node || 'prefixItems' in node) {
    // Tuples carry a positional shape this path language cannot express.
    if ('prefixItems' in node || node.items === undefined) {
      return [{ path, shape: 'unsupported' }];
    }
    if (isScalarSchema(node.items)) return [{ path, shape: 'scalar-array' }];
    return classifySchemaLeaves(node.items, `${path}[]`);
  }

  // A closed object with no properties can hold nothing, so it contributes no
  // leaf at all rather than an unclassifiable one.
  if (node.type === 'object') return [];

  if (isScalarSchema(node)) return [{ path, shape: 'scalar' }];

  return [{ path, shape: 'unsupported' }];
}

/**
 * Every leaf of {@link UserConfigSchema}, classified, derived from the schema
 * itself rather than hand-listed.
 *
 * Reads the generated JSON Schema (the same `z.toJSONSchema` bridge
 * `ConfigManager` uses for its `conf` validation). Only the drift guard calls
 * this, so the cost is never paid at request time.
 *
 * @returns Classified leaves in schema order.
 */
export function configSchemaLeaves(): SchemaLeaf[] {
  return classifySchemaLeaves(z.toJSONSchema(UserConfigSchema, { target: 'jsonSchema2019-09' }));
}

/**
 * Every leaf dot-path of {@link UserConfigSchema}, in schema order.
 *
 * @returns The {@link configSchemaLeaves} paths, without their shapes.
 */
export function configSchemaLeafPaths(): string[] {
  return configSchemaLeaves().map((leaf) => leaf.path);
}
