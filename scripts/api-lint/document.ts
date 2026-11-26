/**
 * Reading the two committed files the API lint gate measures: the OpenAPI
 * document (`docs/api/openapi.json`, kept fresh by `docs-openapi-check`) and
 * the route census (`apps/server/src/http/__tests__/route-census.baseline.json`,
 * kept fresh by the booted census test). Shapes, path helpers and `$ref`
 * resolution live here so the rules module reads as rules.
 *
 * @module scripts/api-lint/document
 */

/** The HTTP methods an OpenAPI path item can hold that the gate judges. */
export const OPERATION_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** One of {@link OPERATION_METHODS}. */
export type OperationMethod = (typeof OPERATION_METHODS)[number];

/** A JSON Schema node, as far as the rules read one. */
export interface SchemaNode {
  /** A reference such as `#/components/schemas/ErrorResponse`. */
  $ref?: string;
  /** One type name, or several (`['array', 'null']`). */
  type?: string | string[];
  /** Object properties. */
  properties?: Record<string, SchemaNode>;
  /** Exactly one of these. */
  oneOf?: SchemaNode[];
  /** At least one of these. */
  anyOf?: SchemaNode[];
  /** All of these. */
  allOf?: SchemaNode[];
  /** An array's item schema. */
  items?: SchemaNode;
  /** The only values allowed. */
  enum?: unknown[];
}

/** A parameter on an operation. */
export interface ParameterNode {
  /** A reference into `components.parameters`. */
  $ref?: string;
  /** The parameter's name. */
  name?: string;
  /** Where it goes: `query`, `path`, `header` or `cookie`. */
  in?: string;
}

/** A response on an operation. */
export interface ResponseNode {
  /** A reference into `components.responses`. */
  $ref?: string;
  /** Media type to body. */
  content?: Record<string, { schema?: SchemaNode }>;
}

/** One operation (a method on a path). */
export interface OperationNode {
  /** The operation's stable id, when it has one. */
  operationId?: string;
  /** Its parameters. */
  parameters?: ParameterNode[];
  /** Status code to response. */
  responses?: Record<string, ResponseNode>;
}

/** The OpenAPI document, as far as the rules read it. */
export interface OpenApiDocument {
  /** Path to path item. */
  paths: Record<string, Partial<Record<string, OperationNode>>>;
  /** Shared components. */
  components?: {
    /** Named schemas. */
    schemas?: Record<string, SchemaNode>;
    /** Named responses. */
    responses?: Record<string, ResponseNode>;
    /** Named parameters. */
    parameters?: Record<string, ParameterNode>;
  };
}

/** One operation with where it lives. */
export interface Operation {
  /** The document path, e.g. `/api/agents/{id}`. */
  path: string;
  /** The lower-case method. */
  method: OperationMethod;
  /** The operation itself. */
  op: OperationNode;
}

/** A served route from the census. */
export interface CensusRoute {
  /** The upper-case method, or `ALL`. */
  method: string;
  /** The path with `{name}` parameters, normalised from Hono's `:name`. */
  path: string;
}

/** A thrown failure that means "could not measure", exit 2. */
export class ApiLintError extends Error {}

/**
 * Parse the OpenAPI document.
 *
 * @param text - The file's text.
 * @param where - The file's name, for errors.
 */
export function parseSpec(text: string, where: string): OpenApiDocument {
  const parsed = parseJson(text, where) as Partial<OpenApiDocument> | null;
  if (!parsed || typeof parsed.paths !== 'object' || parsed.paths === null) {
    throw new ApiLintError(`${where} has no paths map`);
  }
  return parsed as OpenApiDocument;
}

/**
 * Parse the route census into routes with normalised paths.
 *
 * @param text - The file's text.
 * @param where - The file's name, for errors.
 */
export function parseCensus(text: string, where: string): CensusRoute[] {
  const parsed = parseJson(text, where) as { routes?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.routes)) {
    throw new ApiLintError(`${where} has no routes list`);
  }
  return parsed.routes.map((entry: unknown) => {
    const match = typeof entry === 'string' ? /^([A-Z]+) (\S+)$/.exec(entry) : null;
    if (!match) throw new ApiLintError(`${where}: ${JSON.stringify(entry)} is not "METHOD /path"`);
    return { method: match[1] ?? '', path: normalisePath(match[2] ?? '') };
  });
}

function parseJson(text: string, where: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiLintError(`${where} is not valid JSON`);
  }
}

/**
 * Every operation in the document, in document order.
 *
 * @param doc - The OpenAPI document.
 */
export function operations(doc: OpenApiDocument): Operation[] {
  const out: Operation[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of OPERATION_METHODS) {
      const op = item?.[method];
      if (op) out.push({ path, method, op });
    }
  }
  return out;
}

/**
 * Hono's `:name`, `:name?` and `:name{regex}` written as OpenAPI's `{name}`,
 * with any trailing slash dropped.
 *
 * @param path - A census path.
 */
export function normalisePath(path: string): string {
  const named = path.replace(/:([A-Za-z0-9_]+)(\{[^}]*\})?\??/g, '{$1}');
  // A trailing slash names the same route, so `/api/x/` compares as `/api/x`.
  return named.length > 1 ? named.replace(/\/+$/, '') : named;
}

/**
 * A path with every parameter name erased (`/api/agents/{}/pause`), so two
 * spellings of one route compare equal.
 *
 * @param path - A path with `{name}` parameters.
 */
export function erasedPath(path: string): string {
  return path.replace(/\{[^}]*\}/g, '{}');
}

/**
 * The path's segments, without empty ones.
 *
 * @param path - A path.
 */
export function segments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/**
 * Whether a segment is a `{param}`.
 *
 * @param segment - One path segment.
 */
export function isParam(segment: string): boolean {
  return segment.startsWith('{') && segment.endsWith('}');
}

/**
 * The route group a path belongs to: the first segment under `/api`
 * (`sessions` for `/api/sessions/{id}/messages`), or the first segment of a
 * path outside `/api` (`a2a`, `mcp`). The gate's unit, so two PRs in different
 * groups never fight over the baseline.
 *
 * @param path - A document or census path.
 */
export function groupOf(path: string): string {
  const parts = segments(path);
  if (parts[0] === 'api') return parts[1] ?? 'api';
  return parts[0] ?? '/';
}

/**
 * A schema with one `$ref` into `components.schemas` followed, or the schema
 * itself when it is not a reference (or the reference does not resolve).
 *
 * @param doc - The OpenAPI document.
 * @param schema - The schema to resolve.
 */
export function resolveSchema(doc: OpenApiDocument, schema: SchemaNode | undefined): SchemaNode {
  const ref = schema?.$ref;
  const name = ref?.startsWith('#/components/schemas/')
    ? ref.slice('#/components/schemas/'.length)
    : undefined;
  return (name && doc.components?.schemas?.[name]) || schema || {};
}

/**
 * A response with one `$ref` into `components.responses` followed.
 *
 * @param doc - The OpenAPI document.
 * @param response - The response to resolve.
 */
export function resolveResponse(doc: OpenApiDocument, response: ResponseNode): ResponseNode {
  const ref = response.$ref;
  const name = ref?.startsWith('#/components/responses/')
    ? ref.slice('#/components/responses/'.length)
    : undefined;
  return (name && doc.components?.responses?.[name]) || response;
}

/**
 * A parameter with one `$ref` into `components.parameters` followed.
 *
 * @param doc - The OpenAPI document.
 * @param parameter - The parameter to resolve.
 */
export function resolveParameter(doc: OpenApiDocument, parameter: ParameterNode): ParameterNode {
  const ref = parameter.$ref;
  const name = ref?.startsWith('#/components/parameters/')
    ? ref.slice('#/components/parameters/'.length)
    : undefined;
  return (name && doc.components?.parameters?.[name]) || parameter;
}

/**
 * Whether a schema's type is, or includes, `type`.
 *
 * @param schema - The schema.
 * @param type - The type name.
 */
export function hasType(schema: SchemaNode, type: string): boolean {
  return Array.isArray(schema.type) ? schema.type.includes(type) : schema.type === type;
}
