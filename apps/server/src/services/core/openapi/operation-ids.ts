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
 * 2. **Derived** from the method, the document's paths and the operation's
 *    query parameters, for everything else, by {@link deriveOperationId}: `${group}.${verb}${Resource}`. No
 *    schema is ever read, so adding a field to a response never renames an
 *    operation.
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
 *   1. the last segment is a command word ({@link COMMAND_WORDS}, or any word
 *      ending in `-all`): that word in camelCase, and it leaves the Resource
 *      (`/pause` → `pause`, `/read-all` → `readAll`, `/continue/cancel` →
 *      `cancelContinue`);
 *   2. on any method but `GET`, the last segment is hyphenated and its first
 *      word is a command word: the whole segment in camelCase, and it leaves
 *      the Resource (`/revoke-session` → `revokeSession`, `/start-work` →
 *      `startWork`). {@link NAMED_SEGMENTS} lists the few such segments that
 *      name a thing rather than an action (`/link-code`), which stay in the
 *      Resource. A `GET` reads, so its last segment always names what it reads;
 *   3. `GET` → `list` when the path is a collection: it does not end in a
 *      `{param}`, and the document also has the same path with one `{param}`
 *      segment added (`/api/sessions` beside `/api/sessions/{id}`); or when
 *      the operation pages, declaring a `limit` or `cursor` query parameter
 *      (`GET /api/rooms/{id}/entries`). Both read the request's
 *      shape, never a response. Every list pages by cursor, so every list
 *      ends up `list`; `get` otherwise;
 *   4. `POST` → `create`; `PUT` and `PATCH` → `update`; `DELETE` → `delete`;
 *      any other method → its name.
 *
 * | Method   | Path                                                    | operationId                                       |
 * | -------- | ------------------------------------------------------- | ------------------------------------------------- |
 * | `GET`    | `/api/sessions` (beside `/api/sessions/{id}`)           | `sessions.list`                                   |
 * | `GET`    | `/api/sessions/{id}`                                    | `sessions.get`                                    |
 * | `GET`    | `/api/health/deep` (no `/api/health/deep/{id}`)         | `health.getDeep`                                  |
 * | `GET`    | `/api/rooms/{id}/entries` (takes `cursor`)              | `rooms.listEntries`                               |
 * | `POST`   | `/api/sessions`                                         | `sessions.create`                                 |
 * | `POST`   | `/api/sessions/{id}/messages`                           | `sessions.createMessages`                         |
 * | `POST`   | `/api/connectors/connections/{id}/events/subscriptions` | `connectors.createConnectionsEventsSubscriptions` |
 * | `POST`   | `/api/sessions/{id}/continue/cancel`                    | `sessions.cancelContinue`                         |
 * | `POST`   | `/api/agents/{agentId}/pause`                           | `agents.pause`                                    |
 * | `POST`   | `/api/notifications/read-all`                           | `notifications.readAll`                           |
 * | `POST`   | `/api/auth/revoke-session`                              | `auth.revokeSession`                              |
 * | `POST`   | `/api/hub/computers/link-code` (a named segment)        | `hub.createComputersLinkCode`                     |
 * | `PUT`    | `/api/work-queues/stop`                                 | `workQueues.stop`                                 |
 * | `PATCH`  | `/api/config`                                           | `config.update`                                   |
 * | `DELETE` | `/api/work-queues/{id}/items/{itemId}`                  | `workQueues.deleteItems`                          |
 *
 * ## Every id is pinned
 *
 * `__tests__/operation-ids.snapshot.json` maps every `METHOD path` in the
 * generated document to its id, and `__tests__/operation-ids-snapshot.test.ts`
 * fails with a diff when any id changes, appears or goes. Renaming one on
 * purpose is `pnpm vitest run apps/server/src/services/core/openapi/__tests__/operation-ids-snapshot.test.ts -u`
 * (`contributing/api-reference.md`). An id can also change because another
 * route appeared (a sibling `{param}` path) or a `GET` gained a `limit` or
 * `cursor` parameter. Unless that rename is intended, do not run `-u`: pin
 * the old id by hand with `operationId` on the operation's `registerPath` call.
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
    'pause resume halt install fork merge trigger sign'
  ).split(' ')
);

/**
 * Hyphenated segments whose first word is a command word but which name a
 * thing, not an action: a `POST` to one creates that thing (rule 2 in the
 * module doc).
 */
export const NAMED_SEGMENTS: ReadonlySet<string> = new Set([
  'link-code',
  'claim-link',
  'stream-health',
]);

/** An operation, as far as this module reads one. */
interface OperationShape {
  operationId?: string;
  parameters?: Array<{ in?: string; name?: string }>;
}

/** The slice of a generated document this module reads and writes. */
export interface OperationIdDocument {
  /** The document's paths, each mapping methods to operations. */
  paths?: Record<string, object | undefined>;
}

/** What {@link deriveOperationId} knows about the operation besides its own path. */
export interface DeriveOptions {
  /**
   * Whether the document also has this path with one `{param}` segment added
   * (see {@link isCollectionPath}).
   */
  isCollection?: boolean;
  /** Whether the operation declares a `limit` or `cursor` query parameter. */
  isPaged?: boolean;
}

/** Whether a path segment is a `{param}` placeholder. */
function isParam(segment: string): boolean {
  return segment.startsWith('{') && segment.endsWith('}');
}

/** Whether a static segment names an action (rules 1 and 2 in the module doc). */
function isCommandSegment(segment: string, method: string): boolean {
  const word = segment.toLowerCase();
  if (COMMAND_WORDS.has(word) || word.endsWith('-all')) return true;
  if (method === 'get' || NAMED_SEGMENTS.has(word) || !word.includes('-')) return false;
  return COMMAND_WORDS.has(word.slice(0, word.indexOf('-')));
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
function methodVerb(method: string, isList: boolean): string {
  if (method === 'get') return isList ? 'list' : 'get';
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
 * @param options - Whether the path is a collection (see {@link DeriveOptions}).
 * @returns The derived id, `${group}.${verb}${Resource}`.
 */
export function deriveOperationId(
  method: string,
  path: string,
  options: DeriveOptions = {}
): string {
  const lowerMethod = method.toLowerCase();
  const segments = path.split('/').filter(Boolean);
  const [group = 'root', ...after] = segments[0] === 'api' ? segments.slice(1) : segments;
  const statics = after.filter((segment) => !isParam(segment));
  const last = after.at(-1);
  if (last !== undefined && !isParam(last) && isCommandSegment(last, lowerMethod)) {
    return `${camel(group)}.${camel(last)}${pascal(statics.slice(0, -1))}`;
  }
  const endsInParam = last !== undefined && isParam(last);
  const isList = (!endsInParam && options.isCollection === true) || options.isPaged === true;
  const verb = methodVerb(lowerMethod, isList);
  return `${camel(group)}.${verb}${pascal(statics)}`;
}

/**
 * Whether a path is a collection: some other path in the set is this one with
 * one `{param}` segment added (`/api/sessions` beside `/api/sessions/{id}`).
 *
 * @param path - The path to ask about.
 * @param paths - Every path in the document.
 */
export function isCollectionPath(path: string, paths: ReadonlySet<string>): boolean {
  const prefix = `${path.replace(/\/$/, '')}/`;
  for (const other of paths) {
    if (!other.startsWith(prefix)) continue;
    const rest = other.slice(prefix.length);
    if (!rest.includes('/') && isParam(rest)) return true;
  }
  return false;
}

/** The query parameters that mark an operation as paging through a list. */
const PAGING_PARAMS = new Set(['limit', 'cursor']);

/** Whether an operation declares a `limit` or `cursor` query parameter. */
function isPaged(op: OperationShape): boolean {
  return (op.parameters ?? []).some((p) => p.in === 'query' && PAGING_PARAMS.has(p.name ?? ''));
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

  const paths = new Set(Object.keys(document.paths ?? {}));
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
    const id = deriveOperationId(method, path, {
      isCollection: isCollectionPath(path, paths),
      isPaged: isPaged(op),
    });
    claim(id, key);
    op.operationId = id;
  }
}
