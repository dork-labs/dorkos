/**
 * Give every operation in the generated OpenAPI document its `x-stability`:
 * `stable`, `preview` or `internal` (ADR `261123-170832`, DOR-4983).
 *
 * The rule, which `contributing/api-reference.md` states for people:
 *
 * - `internal`: only DorkOS's own app, command line or desktop app calls it,
 *   and it can change without notice: sign-in and account security steps, the
 *   app's own settings pages and plumbing, debug and test hooks.
 * - `preview`: new or still being reshaped: an area the roadmap is rebuilding
 *   (rooms, Relay, the DorkOS account, hubs and agent computers, shared docs),
 *   a list that just started paging (DOR-4982), and every capability route that
 *   has not been promised `stable` on purpose.
 * - `stable`: meant for outside callers: scripts, other programs and agents.
 *
 * Where an operation's value comes from, first match wins:
 *
 * 1. **The operation's own declaration.** A capability's `http.stability`, or
 *    `'x-stability'` on a hand `registerPath` call, or the operation's entry in
 *    {@link OPERATION_STABILITY} (for hand routes, one table beside the groups).
 * 2. **A capability with none** is `internal` in a group marked internal below
 *    and `preview` everywhere else: a route is promised `stable` only by a
 *    line on its capability (see `defaultCapabilityStability`).
 * 3. **A hand route with none** takes its route group's value in
 *    {@link GROUP_STABILITY}. A group missing from the table fails the export,
 *    so a new group is classified the day it is documented.
 *
 * A `preview` operation's description opens with {@link PREVIEW_NOTE}, the
 * note the ADR asks the published document to carry. `internal` operations
 * are left out of the published document (`published-document.ts`).
 *
 * @module services/core/openapi/stability
 */
import { API_STABILITIES, type ApiStability } from '@dorkos/shared/capabilities';

/**
 * Each route group's stability, by its first path segment under `/api`.
 * Sorted by value, then name, documented groups first.
 */
export const GROUP_STABILITY: Readonly<Record<string, ApiStability>> = {
  // Meant for outside callers.
  activity: 'stable',
  agents: 'stable',
  audit: 'stable',
  capabilities: 'stable',
  connectors: 'stable',
  files: 'stable',
  health: 'stable',
  heartbeats: 'stable',
  marketplace: 'stable',
  'mcp-servers': 'stable',
  mesh: 'stable',
  models: 'stable',
  search: 'stable',
  sessions: 'stable',
  tasks: 'stable',
  templates: 'stable',
  'todo-promises': 'stable',
  todos: 'stable',
  'work-queues': 'stable',
  workspaces: 'stable',
  // Being rebuilt (roadmap items 13 to 19): the DorkOS account, hubs and agent
  // computers, team spaces, one message system, published docs.
  canvas: 'preview',
  tunnel: 'preview',
  'read-cursors': 'preview',
  notifications: 'preview',
  config: 'preview',
  commands: 'preview',
  cloud: 'preview',
  'community-connections': 'preview',
  computers: 'preview',
  diff: 'preview',
  'direct-chats': 'preview',
  documents: 'preview',
  // Replay is new (A7, DOR-4986), and most payloads are not described yet.
  events: 'preview',
  hub: 'preview',
  links: 'preview',
  relay: 'preview',
  rooms: 'preview',
  shapes: 'preview',
  // DorkOS's own app, command line and desktop app.
  approvals: 'internal',
  auth: 'internal',
  devices: 'internal',
  directory: 'internal',
  'extension-decisions': 'internal',
  extensions: 'internal',
  harness: 'internal',
  'keep-awake': 'internal',
  'lan-access': 'internal',
  'local-browser': 'internal',
  onboarding: 'internal',
  'owner-factors': 'internal',
  permissions: 'internal',
  profile: 'internal',
  projects: 'internal',
  push: 'internal',
  'remote-access': 'internal',
  runtimes: 'internal',
  'session-locations': 'internal',
  'session-relay': 'internal',
  'step-up': 'internal',
  team: 'internal',
  workbench: 'internal',
  'your-browser': 'internal',
  // Served but not documented yet (the API lint gate's `undocumented-route`).
  // Classified now, so each takes its value the day its routes are documented.
  'openapi.json': 'stable',
  admin: 'internal',
  'agent-instructions': 'internal',
  'browser-viewers': 'internal',
  communities: 'internal',
  debug: 'internal',
  desktop: 'internal',
  discovery: 'internal',
  errors: 'internal',
  'extension-frame': 'internal',
  feedback: 'internal',
  git: 'internal',
  'mcp-config': 'internal',
  'owner-sign-in': 'internal',
  'person-session': 'internal',
  'sign-in-landings': 'internal',
  subagents: 'internal',
  system: 'internal',
  terminal: 'internal',
  uploads: 'internal',
  'wifi-sign-in': 'internal',
};

/**
 * Hand routes whose stability differs from their group's, by `METHOD /path`.
 * Each is a `registerPath` the document already has; a stale key fails the
 * export.
 */
export const OPERATION_STABILITY: Readonly<Record<string, ApiStability>> = {
  // Paged since DOR-4982, so still settling.
  'GET /api/sessions': 'preview',
  'GET /api/sessions/recent': 'preview',
  // The app's own plumbing.
  'POST /api/sessions/{id}/opened': 'internal',
  'POST /api/sessions/{id}/stream-health': 'internal',
  'POST /api/sessions/{id}/ui-action': 'internal',
  'POST /api/sessions/{id}/mcp-app/resource': 'internal',
  'POST /api/sessions/{id}/command-intents/{intent}': 'internal',
  'GET /api/sessions/daily-counts': 'internal',
  // Kept only until GET /api/events carries everything it does (A7, DOR-4986).
  // GET /api/tunnel/stream is the same, but undocumented: describing it would
  // add a verb-path finding, so it waits for A7 to remove it.
  'GET /api/relay/stream': 'internal',
  // Public docs tell outside callers to use these, in groups otherwise internal.
  'PUT /api/runtimes/claude-code/project-accounts': 'preview',
  'PUT /api/extensions/{id}/secrets/{key}': 'preview',
  'GET /api/extensions': 'preview',
};

/** The opening line of every `preview` operation's description. */
export const PREVIEW_NOTE = '**Preview.** This operation may change in any release.';

/** The key an operation carries its stability under. */
export const STABILITY_KEY = 'x-stability';

/** The HTTP methods an OpenAPI path item can hold an operation under. */
const OPERATION_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

/**
 * The route group of an OpenAPI path: its first segment under `/api`.
 *
 * @param path - The OpenAPI path, such as `/api/sessions/{id}`.
 */
export function routeGroup(path: string): string {
  const [, mount, group] = path.split('/');
  return mount === 'api' && group ? group : (mount ?? '');
}

/**
 * Whether a value is one of {@link API_STABILITIES}.
 *
 * @param value - Anything.
 */
export function isApiStability(value: unknown): value is ApiStability {
  return (API_STABILITIES as readonly unknown[]).includes(value);
}

/**
 * The stability of a capability route that declares none: `internal` in a
 * group {@link GROUP_STABILITY} marks internal, `preview` everywhere else.
 *
 * @param path - The capability's HTTP path.
 */
export function defaultCapabilityStability(path: string): ApiStability {
  return GROUP_STABILITY[routeGroup(path)] === 'internal' ? 'internal' : 'preview';
}

/** One operation, as far as {@link assignStability} reads and writes it. */
interface StabilityOperation {
  'x-stability'?: unknown;
  description?: string;
}

/** The slice of a generated document {@link assignStability} reads and writes. */
export interface StabilityDocument {
  /** The document's paths, each mapping methods to operations. */
  paths?: Record<string, object | undefined>;
}

/**
 * Set `x-stability` on every operation that has none: a capability route's
 * default ({@link defaultCapabilityStability}), or a hand route's group value.
 * Then open each `preview` operation's description with {@link PREVIEW_NOTE}.
 *
 * @param document - The generated OpenAPI document; changed in place.
 * @param capabilityRoutes - The `METHOD /path` keys a capability projected.
 * @param checkStale - Whether a key in {@link OPERATION_STABILITY} the document
 *   lacks is an error (off only for a test's small document).
 * @throws If an operation declares a value that is not a stability, or a hand
 *   route's group is not in {@link GROUP_STABILITY}.
 */
export function assignStability(
  document: StabilityDocument,
  capabilityRoutes: ReadonlySet<string> = new Set(),
  checkStale = true
): void {
  const seen = new Set<string>();
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of OPERATION_METHODS) {
      const op = (item as Record<string, StabilityOperation | undefined> | undefined)?.[method];
      if (!op) continue;
      const where = `${method.toUpperCase()} ${path}`;
      const declared = op[STABILITY_KEY];
      if (declared !== undefined && !isApiStability(declared)) {
        throw new Error(
          `${where} declares x-stability "${String(declared)}"; use stable, preview or internal.`
        );
      }
      const stability =
        declared ??
        OPERATION_STABILITY[where] ??
        (capabilityRoutes.has(where)
          ? defaultCapabilityStability(path)
          : GROUP_STABILITY[routeGroup(path)]);
      seen.add(where);
      if (stability === undefined) {
        throw new Error(
          `${where} is in the route group "${routeGroup(path)}", which has no stability. ` +
            'Add the group to GROUP_STABILITY (services/core/openapi/stability.ts), or set ' +
            "'x-stability' on its registerPath call."
        );
      }
      op[STABILITY_KEY] = stability;
      if (stability === 'preview') {
        op.description = op.description ? `${PREVIEW_NOTE}\n\n${op.description}` : PREVIEW_NOTE;
      }
    }
  }
  if (!checkStale) return;
  const stale = Object.keys(OPERATION_STABILITY).filter((key) => !seen.has(key));
  if (stale.length > 0) {
    throw new Error(
      `OPERATION_STABILITY names operations the document does not have: ${stale.join(', ')}.`
    );
  }
}
