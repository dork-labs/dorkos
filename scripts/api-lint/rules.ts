/**
 * The API lint rules (DOR-4996). Each rule reads the OpenAPI document, the
 * route census or the hand registry's source, and returns what it found
 * grouped by unit: the route group for every rule but `hand-registered-path`,
 * whose unit is the file. `scripts/api-lint/check-api-lint.ts` turns the
 * counts into a ratchet; this module only says what is wrong and where.
 *
 * @module scripts/api-lint/rules
 */
import {
  erasedPath,
  groupOf,
  hasType,
  isParam,
  operations,
  resolveParameter,
  resolveResponse,
  resolveSchema,
  segments,
  type CensusRoute,
  type OpenApiDocument,
  type Operation,
  type OperationNode,
  type SchemaNode,
} from './document.ts';

/** Every rule the gate holds, in the order the docs list them. */
export const RULE_IDS = [
  'operation-id',
  'verb-path',
  'param-name',
  'error-missing',
  'error-shape',
  'list-paging',
  'undocumented-route',
  'unserved-operation',
  'hand-registered-path',
] as const;

/** One of {@link RULE_IDS}. */
export type RuleId = (typeof RULE_IDS)[number];

/** Unit to the labels of what a rule found there, e.g. `GET /api/x`. */
export type Items = Record<string, string[]>;

/** How the gate treats one rule. */
export interface RuleSpec {
  /**
   * Whether a rise fails the check. A non-blocking (advisory) rule is still
   * measured, written to the baseline and lowered by `--update`, but its
   * findings print as advisory lines and never set exit 1.
   */
  blocking: boolean;
  /** The one-sentence fix a failure message quotes. */
  fix: string;
}

/**
 * Every rule's treatment. `hand-registered-path` is advisory until the
 * pending list (`apps/server/src/http/hand-routes/pending.json`) is empty:
 * until then hand routes still wait to move onto capability `http` surfaces,
 * and blocking would freeze them rather than guard the API. Routes on the
 * permanent allowlist are never counted.
 */
export const RULES: Record<RuleId, RuleSpec> = {
  'operation-id': { blocking: true, fix: 'Give each new operation a unique operationId.' },
  'verb-path': {
    blocking: true,
    fix: 'Name the resource in the path and let the method be the action (POST /things, not POST /things/create).',
  },
  'param-name': {
    blocking: true,
    fix: 'Use the parameter name this group already uses for that resource.',
  },
  'error-missing': {
    blocking: true,
    fix: 'Declare the 4xx and 5xx responses the handler can send.',
  },
  'error-shape': {
    blocking: true,
    fix: 'Point each 4xx and 5xx body at a shared error schema (ErrorResponse).',
  },
  'list-paging': {
    blocking: true,
    fix: 'Page the list: accept cursor and limit, and return nextCursor.',
  },
  'undocumented-route': {
    blocking: true,
    fix: 'Describe the route in the OpenAPI document, then run `pnpm docs:export-api`.',
  },
  'unserved-operation': {
    blocking: true,
    fix: 'Serve the documented operation, or remove it from the document.',
  },
  'hand-registered-path': {
    // The PR that empties the pending list flips this to `blocking: true`, and must run
    // `--update` in the same PR: the advisory entries may lag the measured count, and a raise
    // is judged against the base.
    blocking: false,
    fix: 'Declare a new route as a capability `http` surface, not a hand registerPath; a stream, bytes, callback, sign-in, page or docs route goes on the hand-route allowlist instead.',
  },
};

/**
 * Static path segments that name an action rather than a resource. A path
 * with one in any static segment is an RPC call dressed as REST; the resource it acts on
 * should be the path, and the method the action. Any segment ending in `-all`
 * counts too ({@link isCommandWord}).
 */
export const COMMAND_WORDS: readonly string[] = (
  'get set create update delete remove list start stop run send add mark reset enable disable ' +
  'toggle check fetch execute cancel approve deny reject register unregister refresh read write ' +
  'open close archive restore sync test validate rebuild reload resolve claim release submit ' +
  'clear move copy link unlink accept decline retry requeue reorder verify probe sign-in ' +
  'sign-out sign-out-all invoke stream confirm revoke undo scan finish export apply upload preview'
).split(' ');

/**
 * Verbs the REST API review allows as sub-resources (`POST /agents/{id}/pause`):
 * each names a state change with no natural noun. Never counted.
 */
export const ALLOWED_VERBS: readonly string[] = [
  'pause',
  'resume',
  'halt',
  'install',
  'fork',
  'merge',
  'trigger',
];

/**
 * Whole paths that end in a command word on purpose. `POST /api/capabilities/{id}/invoke`
 * is the documented RPC projection of every capability (ADR 261123-170830), not a
 * resource that lost its noun, so `verb-path` never counts it. Keep this list short.
 */
export const ALLOWED_VERB_PATHS: readonly string[] = ['/api/capabilities/{id}/invoke'];

/**
 * Schemas a 4xx or 5xx body may reference: the RFC 9457 `Problem` every
 * switched route answers with (DOR-4979), the older `ErrorResponse` the routes
 * not yet switched still send, and the two 428 "confirm first" answers, which
 * are shared, deliberate shapes rather than error one-offs: `StepUpRequired` on
 * every held write and `PasskeyCheckRequired` on the passkey-checked device writes.
 */
export const SHARED_ERROR_SCHEMAS: readonly string[] = [
  'Problem',
  'ErrorResponse',
  'StepUpRequired',
  'PasskeyCheckRequired',
];

/** The paths whose `registerPath(` calls count as hand registrations. */
const HAND_REGISTRY_FILE =
  /^apps\/server\/src\/(?:services\/core\/openapi-registry\.ts|services\/core\/openapi\/[^/]+\.ts|(?:.+\/)?(?:[^/]*-)?openapi\.ts)$/;

/** A test file, which never counts as a registration site. */
const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec)\.ts$/;

/** A `registerPath(` call. */
const REGISTER_CALL = /\bregisterPath\(/g;

/** The same, for one search. */
const REGISTER_CALL_ONCE = /\bregisterPath\(/;

/** A line that is only a comment, so prose quoting a call is not a call. */
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;

/**
 * Whether a static path segment names an action.
 *
 * @param segment - One static path segment.
 */
export function isCommandWord(segment: string): boolean {
  const word = segment.toLowerCase();
  if (ALLOWED_VERBS.includes(word)) return false;
  return COMMAND_WORDS.includes(word) || word.endsWith('-all');
}

function add(items: Items, unit: string, label: string): void {
  (items[unit] ??= []).push(label);
}

function label({ method, path }: Pick<Operation, 'method' | 'path'>): string {
  return `${method.toUpperCase()} ${path}`;
}

/**
 * Operations with no `operationId`.
 *
 * @param doc - The OpenAPI document.
 */
export function operationIdItems(doc: OpenApiDocument): Items {
  const items: Items = {};
  for (const operation of operations(doc)) {
    if (!operation.op.operationId) add(items, groupOf(operation.path), label(operation));
  }
  return items;
}

/**
 * Operation ids two or more operations share: the hard half of
 * `operation-id`, which fails whatever the baseline says. Two ids that match
 * once lowercased with underscores removed count as shared, because the
 * server's generator refuses that pair too.
 *
 * @param doc - The OpenAPI document.
 * @returns Shared id to the operations that carry it.
 */
export function duplicateOperationIds(doc: OpenApiDocument): Record<string, string[]> {
  // Keyed the way the server's generator checks collisions
  // (`services/core/openapi/operation-ids.ts`): lowercased, underscores removed.
  const byKey = new Map<string, { id: string; label: string }[]>();
  for (const operation of operations(doc)) {
    const id = operation.op.operationId;
    if (!id) continue;
    const key = id.toLowerCase().replaceAll('_', '');
    byKey.set(key, [...(byKey.get(key) ?? []), { id, label: label(operation) }]);
  }
  const found: Record<string, string[]> = {};
  for (const ops of byKey.values()) {
    if (ops.length < 2) continue;
    const exact = ops.every((o) => o.id === ops[0]!.id);
    found[ops[0]!.id] = ops.map((o) => (exact ? o.label : `${o.label} (${o.id})`));
  }
  return found;
}

/**
 * Document paths with a static segment that is a command word, one item per
 * such segment.
 *
 * @param doc - The OpenAPI document.
 */
export function verbPathItems(doc: OpenApiDocument): Items {
  const items: Items = {};
  for (const path of Object.keys(doc.paths)) {
    if (ALLOWED_VERB_PATHS.includes(path)) continue;
    for (const segment of segments(path)) {
      if (!isParam(segment) && isCommandWord(segment)) {
        add(items, groupOf(path), `${path} (${segment})`);
      }
    }
  }
  return items;
}

/**
 * Resources whose `{param}` goes by more than one name inside one route
 * group (`/rooms/{id}` beside `/rooms/{roomId}`): distinct names minus one,
 * per resource segment.
 *
 * @param doc - The OpenAPI document.
 */
export function paramNameItems(doc: OpenApiDocument): Items {
  const names = new Map<string, Set<string>>();
  for (const path of Object.keys(doc.paths)) {
    const parts = segments(path);
    for (let i = 0; i + 1 < parts.length; i += 1) {
      const [resource, next] = [parts[i] ?? '', parts[i + 1] ?? ''];
      if (isParam(resource) || !isParam(next)) continue;
      const key = `${groupOf(path)}\0${resource}`;
      const set = names.get(key) ?? new Set<string>();
      names.set(key, set.add(next.slice(1, -1)));
    }
  }
  const items: Items = {};
  for (const [key, set] of names) {
    const [group = '', resource = ''] = key.split('\0');
    const [first, ...rest] = [...set].sort();
    for (const extra of rest) add(items, group, `${resource}: {${extra}} beside {${first}}`);
  }
  return items;
}

function errorStatuses(op: OperationNode): string[] {
  return Object.keys(op.responses ?? {}).filter((status) => /^[45]/.test(status));
}

/**
 * Operations that declare no 4xx or 5xx response.
 *
 * @param doc - The OpenAPI document.
 */
export function errorMissingItems(doc: OpenApiDocument): Items {
  const items: Items = {};
  for (const operation of operations(doc)) {
    if (errorStatuses(operation.op).length === 0) {
      add(items, groupOf(operation.path), label(operation));
    }
  }
  return items;
}

function isSharedErrorRef(schema: SchemaNode | undefined): boolean {
  const isShared = (node: SchemaNode | undefined) =>
    SHARED_ERROR_SCHEMAS.some((name) => node?.$ref === `#/components/schemas/${name}`);
  // A problem with extension members is the shared schema plus its own fields.
  return isShared(schema) || (schema?.allOf ?? []).some(isShared);
}

/**
 * 4xx and 5xx responses whose body (a problem document, else JSON) is not a
 * `$ref` to a shared error schema, or that have no body at all.
 *
 * @param doc - The OpenAPI document.
 */
export function errorShapeItems(doc: OpenApiDocument): Items {
  const items: Items = {};
  for (const operation of operations(doc)) {
    for (const status of errorStatuses(operation.op)) {
      const response = operation.op.responses?.[status];
      const resolved = response ? resolveResponse(doc, response) : {};
      const body =
        resolved.content?.['application/problem+json']?.schema ??
        resolved.content?.['application/json']?.schema;
      if (!isSharedErrorRef(body)) {
        add(items, groupOf(operation.path), `${label(operation)} ${status}`);
      }
    }
  }
  return items;
}

function okSchema(doc: OpenApiDocument, op: OperationNode): SchemaNode | undefined {
  const response = op.responses?.['200'];
  const schema = response && resolveResponse(doc, response).content?.['application/json']?.schema;
  return schema ? resolveSchema(doc, schema) : undefined;
}

/** The schema and, one level down, each member of its `oneOf`, `anyOf` or `allOf`. */
function variants(doc: OpenApiDocument, schema: SchemaNode): SchemaNode[] {
  const members = [...(schema.oneOf ?? []), ...(schema.anyOf ?? []), ...(schema.allOf ?? [])];
  return [schema, ...members.map((member) => resolveSchema(doc, member))];
}

function isListBody(doc: OpenApiDocument, schema: SchemaNode): boolean {
  if (hasType(schema, 'array')) return true;
  return Object.values(schema.properties ?? {}).some((prop) =>
    hasType(resolveSchema(doc, prop), 'array')
  );
}

function isCollectionGet(doc: OpenApiDocument, { path, method, op }: Operation): boolean {
  const last = segments(path).at(-1);
  if (method !== 'get' || !last || isParam(last)) return false;
  const schema = okSchema(doc, op);
  return schema ? variants(doc, schema).some((v) => isListBody(doc, v)) : false;
}

function isPaged(doc: OpenApiDocument, op: OperationNode): boolean {
  const query = new Set(
    (op.parameters ?? [])
      .map((parameter) => resolveParameter(doc, parameter))
      .filter((parameter) => parameter.in === 'query')
      .map((parameter) => parameter.name)
  );
  const schema = okSchema(doc, op);
  const hasNextCursor = schema
    ? variants(doc, schema).some((v) => Boolean(v.properties?.nextCursor))
    : false;
  return query.has('cursor') && query.has('limit') && hasNextCursor;
}

/**
 * List GETs (a static last segment and a 200 body that is an array or holds
 * one) that do not page with `cursor`, `limit` and `nextCursor`.
 *
 * @param doc - The OpenAPI document.
 */
export function listPagingItems(doc: OpenApiDocument): Items {
  const items: Items = {};
  for (const operation of operations(doc)) {
    if (isCollectionGet(doc, operation) && !isPaged(doc, operation.op)) {
      add(items, groupOf(operation.path), label(operation));
    }
  }
  return items;
}

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Whether the route rules judge a path: under `/api/`, but not the test
 * server's `/api/test` control routes or the lazily built `/api/ext/{id}`
 * router, which the census sees as one wildcard.
 *
 * @param path - A path with `{name}` parameters.
 */
export function isJudgedPath(path: string): boolean {
  const erased = erasedPath(path);
  return erased.startsWith('/api/') && !under(erased, '/api/test') && !under(erased, '/api/ext/{}');
}

function servedRoutes(census: readonly CensusRoute[]): CensusRoute[] {
  return census.filter(
    (route) => route.method !== 'ALL' && !route.path.includes('*') && isJudgedPath(route.path)
  );
}

/**
 * Served production routes with no documented operation, compared with
 * parameter names erased so a naming mismatch is `param-name`'s business.
 *
 * @param doc - The OpenAPI document.
 * @param census - The route census.
 */
export function undocumentedRouteItems(
  doc: OpenApiDocument,
  census: readonly CensusRoute[]
): Items {
  const documented = new Set(operations(doc).map((o) => label({ ...o, path: erasedPath(o.path) })));
  const items: Items = {};
  for (const route of servedRoutes(census)) {
    if (!documented.has(`${route.method} ${erasedPath(route.path)}`)) {
      add(items, groupOf(route.path), `${route.method} ${route.path}`);
    }
  }
  return items;
}

/**
 * Whether a census route answers `method` on `path` (both erased): the same
 * route, an `ALL` on the same path (every method), or a `PREFIX/*` wildcard
 * of that method or `ALL` (everything under the prefix).
 */
function answers(route: CensusRoute, method: string, path: string): boolean {
  if (route.method !== 'ALL' && route.method !== method) return false;
  const routePath = erasedPath(route.path);
  if (routePath.endsWith('/*')) return under(path, routePath.slice(0, -2));
  return routePath === path;
}

/**
 * Documented operations no served route answers. Unlike
 * {@link undocumentedRouteItems}, an `ALL` entry or a `/*` wildcard counts as
 * serving here: it does answer the request, it is just not a route of its own.
 *
 * @param doc - The OpenAPI document.
 * @param census - The route census.
 */
export function unservedOperationItems(
  doc: OpenApiDocument,
  census: readonly CensusRoute[]
): Items {
  const items: Items = {};
  for (const operation of operations(doc)) {
    if (!isJudgedPath(operation.path)) continue;
    const [method, path] = [operation.method.toUpperCase(), erasedPath(operation.path)];
    if (!census.some((route) => answers(route, method, path))) {
      add(items, groupOf(operation.path), label(operation));
    }
  }
  return items;
}

/**
 * Whether a repo-relative file is part of the hand-written OpenAPI registry:
 * `openapi-registry.ts`, `services/core/openapi/*.ts`, or any `*-openapi.ts`
 * or `openapi.ts` under `apps/server/src`. Tests never are.
 *
 * @param file - A repo-relative path.
 */
export function isHandRegistryFile(file: string): boolean {
  return HAND_REGISTRY_FILE.test(file) && !TEST_FILE.test(file);
}

/** A route the hand registry may keep documenting: `ALL` matches any method, a trailing `/*` any path under it. */
export interface KeptRoute {
  /** Upper-case method, or `ALL`. */
  readonly method: string;
  /** Path in Hono (`:id`) or OpenAPI (`{id}`) form. */
  readonly path: string;
}

/** A path with every parameter, whatever its spelling, reduced to `:`. */
function paramShape(path: string): string {
  return path.replace(/\{[^}]*\}/g, ':').replace(/:[^/]*/g, ':');
}

/**
 * Whether a registered operation is one of the kept routes.
 *
 * @param kept - The routes the hand registry may keep.
 * @param method - The operation's method, any case.
 * @param path - The operation's OpenAPI path.
 */
export function isKeptRoute(kept: readonly KeptRoute[], method: string, path: string): boolean {
  const shape = paramShape(path);
  return kept.some((route) => {
    if (route.method !== 'ALL' && route.method !== method.toUpperCase()) return false;
    const want = paramShape(route.path);
    return want.endsWith('/*')
      ? shape.startsWith(want.slice(0, -1)) || shape === want.slice(0, -2)
      : shape === want;
  });
}

/**
 * The 1-based line of every `registerPath(` call in one file's text, once
 * per call, skipping comment lines and any call whose literal `method` and
 * `path` name a kept route (the permanent hand-route allowlist).
 *
 * @param text - The file's source.
 * @param kept - The routes the hand registry may keep documenting.
 */
export function registerPathLines(text: string, kept: readonly KeptRoute[] = []): number[] {
  const lines: number[] = [];
  const all = text.split('\n');
  all.forEach((line, i) => {
    if (COMMENT_LINE.test(line)) return;
    const calls = [...line.matchAll(REGISTER_CALL)];
    for (const call of calls) {
      // The call's own text: from it to the next call, or a few lines on.
      const rest = [line.slice(call.index! + 1), ...all.slice(i + 1, i + 8)].join('\n');
      const next = rest.search(REGISTER_CALL_ONCE);
      const own = next === -1 ? rest : rest.slice(0, next);
      const method = /\bmethod:\s*'(\w+)'/.exec(own)?.[1];
      const path = /\bpath:\s*['`]([^'`$]+)['`]/.exec(own)?.[1];
      if (method && path && isKeptRoute(kept, method, path)) continue;
      lines.push(i + 1);
    }
  });
  return lines;
}
