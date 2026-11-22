/**
 * Give every operation in the generated OpenAPI document an `operationId`.
 *
 * An `operationId` is the name a generated client calls an operation by. So
 * it has to exist on every operation, be unique, and stay put: changing one is
 * an API change. (The docs site still files its pages by path and method,
 * `apps/site/scripts/generate-api-docs.ts`, so an id change moves no page.)
 *
 * Two sources, in order:
 *
 * 1. **Set by hand.** A `registerPath` call that names an `operationId` keeps
 *    it. Capability-projected paths always do: theirs is the capability id
 *    (`audit.get`), because the REST path and the invoke endpoint are two
 *    documented doors onto one capability definition. Capability ids keep
 *    their own style (snake_case words, and sometimes another group than the
 *    path's: `audit.running_chats` on `/api/sessions/running`).
 * 2. **Derived** from the method, the path and the response, for everything
 *    else, by {@link deriveOperationId}: `${group}.${verb}${Resource}`.
 *
 * ## The derivation rule
 *
 * - **group**: the first path segment after `/api`, in camelCase
 *   (`work-queues` → `workQueues`). A path outside `/api` (`/mcp`) uses its
 *   own first segment.
 * - **Resource**: the static segments after the group, in path order,
 *   PascalCase, kept as written. No singular forms: there is no inflection
 *   library here.
 * - **verb**, in this order:
 *   1. the path ends in a command word ({@link COMMAND_WORDS}, or any word
 *      ending in `-all`): that word in camelCase, and it leaves the Resource
 *      (`/pause` → `pause`, `/read-all` → `readAll`, `/continue/cancel` →
 *      `cancelContinue`);
 *   2. `GET` → `get` when the path ends in a `{param}`; otherwise `list` when
 *      its `200` JSON body (one `$ref` resolved) is an array or has a top-level
 *      array property, else `get`;
 *   3. `POST` → `create`; `PUT` and `PATCH` → `update`; `DELETE` → `delete`;
 *      any other method → its name.
 *
 * | Method   | Path                                                    | operationId                                       |
 * | -------- | ------------------------------------------------------- | ------------------------------------------------- |
 * | `GET`    | `/api/sessions` (a list)                                | `sessions.list`                                   |
 * | `GET`    | `/api/sessions/{id}` (an item, whatever its body holds) | `sessions.get`                                    |
 * | `GET`    | `/api/sessions/{id}/messages` (a list)                  | `sessions.listMessages`                           |
 * | `GET`    | `/api/health` (one object)                              | `health.get`                                      |
 * | `GET`    | `/api/sessions/{id}/settings` (one object)              | `sessions.getSettings`                            |
 * | `POST`   | `/api/sessions`                                         | `sessions.create`                                 |
 * | `POST`   | `/api/sessions/{id}/messages`                           | `sessions.createMessages`                         |
 * | `POST`   | `/api/connectors/connections/{id}/events/subscriptions` | `connectors.createConnectionsEventsSubscriptions` |
 * | `POST`   | `/api/sessions/{id}/continue/cancel`                    | `sessions.cancelContinue`                         |
 * | `POST`   | `/api/agents/{id}/pause`                                | `agents.pause`                                    |
 * | `POST`   | `/api/notifications/read-all`                           | `notifications.readAll`                           |
 * | `PUT`    | `/api/work-queues/stop`                                 | `workQueues.stop`                                 |
 * | `PATCH`  | `/api/config`                                           | `config.update`                                   |
 * | `DELETE` | `/api/work-queues/{id}/items/{itemId}`                  | `workQueues.deleteItems`                          |
 *
 * ## Collisions fail the export
 *
 * Two operations whose ids match once lowercased with underscores removed
 * (`x.foo_bar` and `x.fooBar`), derived or hand-set, throw at generation time
 * with both named, so `pnpm docs:export-api` (and the `openapi-fresh` check)
 * fails rather than emitting two names a client generator would merge. The fix
 * is a hand-set `operationId` on one of the two `registerPath` calls.
 *
 * @module services/core/openapi/operation-ids
 */

/** The HTTP methods an OpenAPI path item can hold an operation under. */
const OPERATION_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

/**
 * Static path segments that name an action. Kept in step with the API lint's
 * own list (its `COMMAND_WORDS` plus the state-change verbs it allows).
 */
export const COMMAND_WORDS: ReadonlySet<string> = new Set(
  (
    'get set create update delete remove list start stop run send add mark reset enable disable ' +
    'toggle check fetch execute cancel approve deny reject register unregister refresh read write ' +
    'open close archive restore sync test validate rebuild reload resolve claim release submit ' +
    'clear move copy link unlink accept decline retry requeue reorder verify probe sign-in ' +
    'sign-out invoke stream confirm revoke undo scan finish export apply upload preview ' +
    'pause resume halt install fork merge trigger'
  ).split(' ')
);

/** A schema, as far as this module reads one. */
interface SchemaShape {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, SchemaShape>;
}

/** An operation, as far as this module reads one. */
interface OperationShape {
  operationId?: string;
  responses?: Record<string, { content?: Record<string, { schema?: SchemaShape }> }>;
}

/** The slice of a generated document this module reads and writes. */
export interface OperationIdDocument {
  /** The document's paths, each mapping methods to operations. */
  paths?: Record<string, object | undefined>;
  /** Its components, for resolving a response's `$ref`. */
  components?: { schemas?: Record<string, unknown> };
}

/** What {@link deriveOperationId} knows about the operation besides its path. */
export interface DeriveOptions {
  /** Whether its `200` JSON body is a list (see the module doc). */
  returnsList?: boolean;
}

/** Whether a path segment is a `{param}` placeholder. */
function isParam(segment: string): boolean {
  return segment.startsWith('{') && segment.endsWith('}');
}

/** Whether a static segment names an action. */
function isCommandWord(segment: string): boolean {
  const word = segment.toLowerCase();
  return COMMAND_WORDS.has(word) || word.endsWith('-all');
}

/** Split a segment into its words (`read-all` → `read`, `all`). */
function words(segment: string): string[] {
  return segment.split(/[^A-Za-z0-9]+/).filter(Boolean);
}

/** Capitalize a word's first letter, leaving the rest as written. */
function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** A segment in camelCase (`work-queues` → `workQueues`). */
function camel(segment: string): string {
  const [first = '', ...others] = words(segment);
  return first.charAt(0).toLowerCase() + first.slice(1) + others.map(capitalize).join('');
}

/** Segments joined in PascalCase (`claude-code`, `models` → `ClaudeCodeModels`). */
function pascal(segments: readonly string[]): string {
  return segments.flatMap(words).map(capitalize).join('');
}

/** The verb for a method with no command word, by the rule in the module doc. */
function methodVerb(method: string, endsInParam: boolean, returnsList: boolean): string {
  if (method === 'get') return !endsInParam && returnsList ? 'list' : 'get';
  if (method === 'post') return 'create';
  if (method === 'put' || method === 'patch') return 'update';
  return method;
}

/**
 * Derive an operation's id from its method and path, by the rule in the module
 * doc.
 *
 * @param method - The HTTP method, any case.
 * @param path - The OpenAPI path, with `{param}` segments.
 * @param options - What else is known about the operation (see {@link DeriveOptions}).
 * @returns The derived id, `${group}.${verb}${Resource}`.
 */
export function deriveOperationId(
  method: string,
  path: string,
  options: DeriveOptions = {}
): string {
  const segments = path.split('/').filter(Boolean);
  const [group = 'root', ...after] = segments[0] === 'api' ? segments.slice(1) : segments;
  const statics = after.filter((segment) => !isParam(segment));
  const last = after.at(-1);
  if (last !== undefined && !isParam(last) && isCommandWord(last)) {
    return `${camel(group)}.${camel(last)}${pascal(statics.slice(0, -1))}`;
  }
  const endsInParam = last !== undefined && isParam(last);
  const verb = methodVerb(method.toLowerCase(), endsInParam, options.returnsList === true);
  return `${camel(group)}.${verb}${pascal(statics)}`;
}

/** Resolve one local `$ref` against the document's schemas. */
function resolve(schema: SchemaShape | undefined, document: OperationIdDocument): SchemaShape {
  const prefix = '#/components/schemas/';
  if (!schema?.$ref?.startsWith(prefix)) return schema ?? {};
  const target = document.components?.schemas?.[schema.$ref.slice(prefix.length)];
  return (target as SchemaShape | undefined) ?? {};
}

/** Whether a schema's `type` is, or includes, `array`. */
function isArray(schema: SchemaShape | undefined): boolean {
  const type = schema?.type;
  return Array.isArray(type) ? type.includes('array') : type === 'array';
}

/**
 * Whether an operation's `200` JSON body is a list: an array, or an object with
 * a top-level array property, after one `$ref` is resolved.
 *
 * @param op - The operation.
 * @param document - The document, for its component schemas.
 */
function returnsList(op: OperationShape, document: OperationIdDocument): boolean {
  const body = resolve(op.responses?.['200']?.content?.['application/json']?.schema, document);
  return isArray(body) || Object.values(body.properties ?? {}).some(isArray);
}

/** The key two ids collide on: lowercased, underscores removed. */
function collisionKey(id: string): string {
  return id.toLowerCase().replaceAll('_', '');
}

/**
 * Set an `operationId` on every operation of a generated document that lacks
 * one, and refuse any two that collide (see the module doc). Hand-set ids are
 * kept as they are.
 *
 * @param document - The generated OpenAPI document; changed in place.
 * @throws If two operations' ids collide, naming both.
 */
export function assignOperationIds(document: OperationIdDocument): void {
  const operations: Array<{ key: string; method: string; path: string; op: OperationShape }> = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of OPERATION_METHODS) {
      const op = (item as Record<string, OperationShape | undefined> | undefined)?.[method];
      if (op) operations.push({ key: `${method.toUpperCase()} ${path}`, method, path, op });
    }
  }

  const owners = new Map<string, { id: string; key: string }>();
  const claim = (id: string, key: string): void => {
    const other = owners.get(collisionKey(id));
    if (other !== undefined) {
      throw new Error(
        `Two operations share the operationId "${id}": ${other.key} ("${other.id}") and ` +
          `${key} ("${id}"). Give one of them its own operationId in its registerPath call.`
      );
    }
    owners.set(collisionKey(id), { id, key });
  };

  // Hand-set ids claim first, so a derived id that collides with one is the
  // one reported against it.
  for (const { key, op } of operations) if (op.operationId) claim(op.operationId, key);
  for (const { key, method, path, op } of operations) {
    if (op.operationId) continue;
    const id = deriveOperationId(method, path, { returnsList: returnsList(op, document) });
    claim(id, key);
    op.operationId = id;
  }
}
