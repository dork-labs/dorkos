/**
 * Write every nullable `$ref` the way OpenAPI 3.1 means it (DOR-5473).
 *
 * `zod-to-openapi` (9.x, OpenAPI 3.1) writes `Ref.nullable()` as
 * `allOf: [{ $ref }, { type: [<ref's type>, 'null'], ...metadata }]`: it treats
 * the added `null` as metadata on top of the ref. Its 3.1 path writes
 * `oneOf: [{ $ref }, { type: 'null' }]` only for a ref still being built (a
 * recursive one). `allOf` means "both", and the referenced schema itself never
 * accepts `null`, so the document says `null` is refused where the server
 * accepts it (a generated client then types such a field
 * `State & (string | null)`, which `null` cannot pass). This pass rewrites each
 * one as `anyOf: [{ $ref }, { type: 'null' }]`, with any other metadata the
 * second part carried (a description, a default) moved up beside the `anyOf`.
 *
 * @module services/core/openapi/nullable-refs
 */

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The referenced schema's `type`, when the ref points at a component schema. */
function refType(schemas: Node, ref: unknown): unknown {
  if (typeof ref !== 'string' || !ref.startsWith('#/components/schemas/')) return undefined;
  const target = schemas[ref.slice('#/components/schemas/'.length)];
  return isNode(target) ? target.type : undefined;
}

/**
 * A library-written nullable ref's `anyOf` and the metadata to lift beside it,
 * or `undefined` when `node` is not one.
 */
function asNullableRef(
  node: Node,
  schemas: Node
): { anyOf: unknown[]; metadata: Node } | undefined {
  const { allOf } = node;
  if (!Array.isArray(allOf) || allOf.length !== 2) return undefined;
  const [ref, nullable] = allOf as unknown[];
  if (!isNode(ref) || Object.keys(ref).length !== 1 || !('$ref' in ref)) return undefined;
  if (!isNode(nullable)) return undefined;
  const { type, ...metadata } = nullable;
  if (!Array.isArray(type) || type.length !== 2 || !type.includes('null')) return undefined;
  if (type.find((t) => t !== 'null') !== refType(schemas, ref.$ref)) return undefined;
  return { anyOf: [ref, { type: 'null' }], metadata };
}

/**
 * Rewrite every library-written nullable `$ref` in a generated document, in place.
 *
 * @param document - The generated OpenAPI document.
 */
export function fixNullableRefs(document: object): void {
  const components = (document as { components?: { schemas?: Node } }).components;
  const schemas = components?.schemas ?? {};
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isNode(value)) return;
    const nullableRef = asNullableRef(value, schemas);
    if (nullableRef) {
      delete value.allOf;
      Object.assign(value, nullableRef.metadata, { anyOf: nullableRef.anyOf });
    }
    Object.values(value).forEach(visit);
  };
  visit(document);
}
