/**
 * The generic capability mount (ADR 261123-170830): one route for every
 * capability that declares an `http` surface, so declaring the surface is what
 * serves the path.
 *
 * Each route turns its request into the capability's input (path segments,
 * then the query string, then the JSON body for a write; see
 * {@link HttpSurface}) and hands it to {@link dispatchCapability}, the same
 * dispatcher `POST /api/capabilities/{id}/invoke` uses. So a REST path and the
 * invoke endpoint meet the same tier gate, Wi-Fi rule, approval header and
 * statuses.
 *
 * ## Why the route table is static
 *
 * The routes are built from the capability DECLARATIONS
 * (`composeCapabilityRegistryForDocs`, the same list the OpenAPI document is
 * projected from), not from the live registry, and each request looks its
 * capability up in the live registry when it arrives. A surface is metadata
 * that depends on no service, so the table is the same on every server and in
 * every test, the route census sees it whatever started, and a collision with a
 * hand route fails when the app is built rather than on a request. The live
 * registry is read per request because it is composed and handed over during
 * boot; a capability whose domain did not start answers `404`
 * ({@link NOT_ON_THIS_COMPUTER}), and a server
 * still starting answers `503`.
 *
 * ## Hand routes
 *
 * Hono runs the first route registered that matches a request, so the mount is
 * registered before every hand route group, and its own routes run static
 * before param ({@link compareRouteSpecificity}): `GET /api/sessions/running`
 * is answered before any `GET /api/sessions/:id` can be.
 * {@link assertNoCapabilityRouteCollisions} throws when the app is built if a
 * hand route claims a capability's METHOD + path, if a hand route registered
 * earlier would answer any of a capability's requests, if a capability would
 * answer requests a more specific hand route registered later is meant for, or
 * if hand middleware registered after the mount covers a capability path (it
 * would never run for it: the capability's own gate must do its job).
 * {@link HAND_SERVED_CAPABILITIES} lists the capabilities whose path a hand
 * route still serves while it moves onto this mount; the list may only shrink.
 *
 * @module routes/capability-http
 */
import { Hono, type Context } from 'hono';
import type { HttpSurface } from '@dorkos/shared/capabilities';

import type {
  CapabilityDefinition,
  CapabilityRegistry,
} from '../services/core/capabilities/index.js';
import { composeCapabilityRegistryForDocs } from '../services/core/self-description/dorkos-registry.js';
import type { ApiEnv } from '../http/api-chain.js';
import { dispatchCapability, type CapabilityDoorPorts } from './capability-dispatch.js';
import { problem, readJsonBody } from '@dorkos/http-kit';
import { readQuery } from '../http/request-query.js';

/**
 * Capabilities whose declared path a hand route still serves, each with the
 * reason. The mount skips them, so the hand route is the only claim on the path.
 * Each entry leaves this list in the change that deletes its hand route; none
 * may join it.
 */
export const HAND_SERVED_CAPABILITIES: Readonly<Record<string, string>> = Object.freeze({
  'rooms.reseat_options': 'routes/room-reseat.ts; moves onto the mount with the rooms domain',
  'rooms.reseat': 'routes/room-reseat.ts; moves onto the mount with the rooms domain',
  'capabilities.list': 'routes/capabilities-catalog.ts; moves onto the mount with its page shape',
});

/** Why a connection capability may skip the connector group's migration gate. */
const CONNECTOR_GATE_FOLDED_IN =
  'The capability declares the connector-store precheck, which answers the same 503 first.';

/** Why the task reads may skip the task step-up middleware. */
const TASK_STEP_UP_WRITES_ONLY = 'The task step-up asks only before a write, and this is a read.';

/** Why the chat reads (`session/reads/session-read-capabilities.ts`) may skip the session read guard. */
const SESSION_READS_FOLD_THE_GUARD =
  'The chat reads fold the session read guard in: an agent gets 404 for a chat it may not read.';

/**
 * Why an extension door may take `/api/extensions/media/<verb>`: an extension
 * called `media` keeps its own doors, as on the hand routes, which the video
 * route is mounted after on purpose (`http/hono-api.ts`).
 */
const EXTENSION_ID_BEFORE_MEDIA =
  'The video route answers only a ticket, and is mounted after the extension routes on purpose.';

/**
 * Hand middleware a capability path may skip, keyed `METHOD /path skips ALL
 * /pattern` (Hono paths), each with why it has nothing to do there. Every
 * other middleware registered after the mount on a capability path refuses the
 * app ({@link assertNoCapabilityRouteCollisions}). Add one only when the
 * middleware could never act on the path; otherwise fold its check into the
 * capability.
 */
export const SKIPPABLE_MIDDLEWARE: Readonly<Record<string, string>> = Object.freeze({
  'GET /api/sessions/running skips ALL /api/sessions/:id/*':
    'The session read guard acts only on a session id, and `running` is not one.',
  'GET /api/sessions/:id/runs skips ALL /api/sessions/:id/*':
    '`runs.chat_runs` folds the session read guard in: an agent gets 404 for a chat it may not read.',
  'GET /api/sessions/:id/tree skips ALL /api/sessions/:id/*':
    '`work-graph.chat_tree` folds the session read guard in: an agent gets 404 for a chat it may not read.',
  'GET /api/sessions/:id/work skips ALL /api/sessions/:id/*':
    '`work-graph.chat_work` folds the session read guard in: an agent gets 404 for a chat it may not read.',
  'GET /api/sessions/:id/runtime-type skips ALL /api/sessions/:id/*': SESSION_READS_FOLD_THE_GUARD,
  'GET /api/sessions/:id/settings skips ALL /api/sessions/:id/*': SESSION_READS_FOLD_THE_GUARD,
  // `askForPersonBeforeTaskWrite` asks for the step-up only before a write; these are reads.
  // The connector store's migration gate is folded in (`http.precheck: 'connector-store'`).
  'GET /api/connectors/connections/:connectionId/disconnect-impact skips ALL /api/connectors/*':
    CONNECTOR_GATE_FOLDED_IN,
  'PATCH /api/connectors/connections/:connectionId skips ALL /api/connectors/*':
    CONNECTOR_GATE_FOLDED_IN,
  'POST /api/connectors/connections/:connectionId/remove skips ALL /api/connectors/*':
    CONNECTOR_GATE_FOLDED_IN,
  'GET /api/connectors/authentication-flows/:flowId skips ALL /api/connectors/*':
    CONNECTOR_GATE_FOLDED_IN,
  'GET /api/connectors/reviews/:reviewRequestId skips ALL /api/connectors/*':
    CONNECTOR_GATE_FOLDED_IN,
  'GET /api/connectors/agent-requests/:requestId/authentication-flows/:flowId skips ALL /api/connectors/*':
    CONNECTOR_GATE_FOLDED_IN,
  'DELETE /api/connectors/connections/:connectionId/every-agent skips ALL /api/connectors/*':
    CONNECTOR_GATE_FOLDED_IN,
  'PUT /api/connectors/connections/:connectionId/exclusions/:agentId skips ALL /api/connectors/*':
    CONNECTOR_GATE_FOLDED_IN,
  'GET /api/connectors/usage/operator skips ALL /api/connectors/*': CONNECTOR_GATE_FOLDED_IN,
  'GET /api/tasks skips ALL /api/tasks': TASK_STEP_UP_WRITES_ONLY,
  'GET /api/tasks skips ALL /api/tasks/*': TASK_STEP_UP_WRITES_ONLY,
  'GET /api/tasks/runs skips ALL /api/tasks/*': TASK_STEP_UP_WRITES_ONLY,
  'GET /api/tasks/runs/:id skips ALL /api/tasks/*': TASK_STEP_UP_WRITES_ONLY,
  ...Object.fromEntries(
    ['dismiss-approval', 'remove', 'forget', 'restart'].map((verb) => [
      `POST /api/extensions/:id/${verb} skips ALL /api/extensions/media/:ticket`,
      EXTENSION_ID_BEFORE_MEDIA,
    ])
  ),
});

/** What a declared path answers when its capability did not start on this server. */
export const NOT_ON_THIS_COMPUTER = "This isn't available on this computer.";

/** A capability the mount serves: one that declares an `http` surface. */
type ServedCapability = CapabilityDefinition & { surfaces: { http: HttpSurface } };

/** The `{name}` segments of an OpenAPI-form path, in order. */
function pathSegments(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
}

/**
 * An OpenAPI-form path (`/api/agents/{agentId}/pause`) as Hono writes it
 * (`/api/agents/:agentId/pause`).
 *
 * @param path - The surface's path.
 * @returns The Hono path.
 */
export function honoPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ':$1');
}

/**
 * The key two routes collide on: the method and the path with every parameter's
 * name (and pattern) dropped and no trailing slash, since `/a/:x` and `/a/:y`
 * answer the same requests.
 *
 * @param method - The route's method.
 * @param path - The route's Hono path.
 * @returns `METHOD /path/:/…`.
 */
export function routeKey(method: string, path: string): string {
  const shape = path.replace(/:[^/{]+(\{[^}]*\})?/g, ':').replace(/(.)\/$/, '$1');
  return `${method.toUpperCase()} ${shape}`;
}

/**
 * The capabilities this server serves on the mount: every declared `http`
 * surface, less {@link HAND_SERVED_CAPABILITIES}.
 *
 * @returns The capabilities, in declaration order.
 */
export function mountedCapabilities(): readonly CapabilityDefinition[] {
  return composeCapabilityRegistryForDocs().capabilities.filter(
    (capability) => capability.surfaces.http && !(capability.id in HAND_SERVED_CAPABILITIES)
  );
}

/** What the mount reads. */
export interface CapabilityHttpDeps {
  /** The composed registry, read per request: `undefined` until boot hands it over. */
  registry: () => CapabilityRegistry | undefined;
  /** The capabilities to serve; only those with an `http` surface get a route. */
  capabilities: readonly CapabilityDefinition[];
  /** The bars and prechecks a declared capability runs first; see {@link CapabilityDoorPorts}. */
  ports?: CapabilityDoorPorts;
}

/**
 * The capability's input from one request: the query fields the surface reads,
 * then the JSON body for a write, then the path's segments, which win.
 *
 * A write's body that is not an object is passed on as it is, so the
 * capability's schema refuses it as it would on the invoke endpoint.
 */
function requestInput(c: Context<ApiEnv>, surface: HttpSurface): unknown {
  const isWrite =
    surface.method === 'post' || surface.method === 'put' || surface.method === 'patch';
  const fromPath: Record<string, string> = {};
  for (const segment of pathSegments(surface.path)) {
    fromPath[surface.params?.[segment] ?? segment] = c.req.param(segment)!;
  }
  const query = readQuery(c);
  const fromQuery = surface.query
    ? Object.fromEntries(
        surface.query.filter((key) => key in query).map((key) => [key, query[key]])
      )
    : isWrite
      ? {}
      : { ...query };
  if (!isWrite) return { ...fromQuery, ...fromPath };
  const body = readJsonBody(c, { emptyAs: {} });
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  return { ...body, ...fromQuery, ...fromPath };
}

/**
 * Build the mount: one route per capability with an `http` surface, at its
 * full path, for `app.route('/', …)`.
 *
 * @param deps - The registry and the capabilities; see {@link CapabilityHttpDeps}.
 * @returns The routes.
 * @throws When two surfaces answer the same METHOD + path.
 */
export function createCapabilityHttpRoutes(deps: CapabilityHttpDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  const claimed = new Map<string, string>();
  // Static before param, so a fixed path is never answered by a sibling's `:id`.
  // Only the served ones are sorted, so the comparator sees no surface-less entry.
  const ordered = deps.capabilities
    .filter((capability): capability is ServedCapability => capability.surfaces.http !== undefined)
    .sort((a, b) =>
      compareRouteSpecificity(honoPath(a.surfaces.http.path), honoPath(b.surfaces.http.path))
    );
  for (const capability of ordered) {
    const surface = capability.surfaces.http;
    const path = honoPath(surface.path);
    const key = routeKey(surface.method, path);
    const other = claimed.get(key);
    if (other) {
      throw new Error(
        `Capabilities "${other}" and "${capability.id}" both declare ${key}; give one another path.`
      );
    }
    claimed.set(key, capability.id);
    const served = capability as ServedCapability;
    const handler = (c: Context<ApiEnv>) => {
      if (surface.noStore) c.header('Cache-Control', 'no-store');
      const registry = deps.registry();
      // The path is declared on every server, but its domain may not have
      // started on this one (no mesh, say): not here, rather than "unknown".
      if (registry && !registry.get(served.id)) {
        return problem(c, 'unknown_capability', { detail: NOT_ON_THIS_COMPUTER });
      }
      return dispatchCapability(c, {
        registry,
        id: served.id,
        input: requestInput(c, surface),
        ...(surface.success ? { success: surface.success } : {}),
        rest: true,
        ...(deps.ports ? { ports: deps.ports } : {}),
      });
    };
    MOUNT_HANDLERS.add(handler);
    router.on(surface.method.toUpperCase(), path, handler);
  }
  return router;
}

/**
 * Refuse to start when the registry holds a capability behind the
 * account-decision bar (`http.callerBar: 'account-decision'`) and the doors
 * were given no policy to run it with. The person bar needs none: the mount
 * runs `assessPerson` itself. Without
 * one the mount mints no proof and the registry refuses every such call, so
 * this is a wiring fault, said at boot rather than as a refusal on each request.
 *
 * @param registry - The composed registry.
 * @param ports - What the doors were given.
 * @throws Naming the capabilities left without their bar.
 */
export function assertCallerBarWired(
  registry: Pick<CapabilityRegistry, 'capabilities'>,
  ports: CapabilityDoorPorts | undefined
): void {
  if (ports?.accountDecision) return;
  const barred = registry.capabilities
    .filter((capability) => capability.surfaces.http?.callerBar === 'account-decision')
    .map((capability) => capability.id);
  if (barred.length > 0) {
    throw new Error(
      `Capabilities ${barred.join(', ')} declare the account-decision bar, but the HTTP ` +
        'doors were given no policy for it (`capabilityPorts.accountDecision`).'
    );
  }
}

/**
 * Every handler the mount registered, so the collision check knows the mount's
 * own routes by what they run, never by where they sit in the app.
 */
const MOUNT_HANDLERS = new WeakSet<object>();

/**
 * Whether a route of the built app is one the mount registered. Hono wraps a
 * sub-app's handler when the sub-app has its own error handler, and keeps the
 * original on `__COMPOSED_HANDLER`.
 */
function isMountRoute(handler: unknown): boolean {
  if (typeof handler !== 'function') return false;
  const inner = (handler as { __COMPOSED_HANDLER?: unknown }).__COMPOSED_HANDLER;
  return MOUNT_HANDLERS.has(handler) || (typeof inner === 'function' && MOUNT_HANDLERS.has(inner));
}

/** One segment of a route pattern, by what it matches. */
type PatternSegment = { kind: 'static'; value: string } | { kind: 'param' } | { kind: 'rest' };

/** A `:name{regex}` whose pattern can match a `/` (`{.+}`, `{.*}`), so it spans segments. */
const SPLAT_PARAM = /^:[^{]*\{.*(?<!\\)\.[+*].*\}$/;

/**
 * A Hono path's segments: `*` and a splat param (`:path{.+}`) match the rest,
 * any other `:name` (with any `{regex}`) one segment.
 */
function patternSegments(path: string): PatternSegment[] {
  return path
    .split('/')
    .filter(Boolean)
    .map((segment): PatternSegment =>
      segment === '*' || SPLAT_PARAM.test(segment)
        ? { kind: 'rest' }
        : segment.startsWith(':')
          ? { kind: 'param' }
          : { kind: 'static', value: segment }
    );
}

/** Whether some request path matches both patterns. A `*` matches zero or more segments. */
function patternsOverlap(a: readonly PatternSegment[], b: readonly PatternSegment[]): boolean {
  const [x, y] = [a[0], b[0]];
  if (x?.kind === 'rest' || y?.kind === 'rest') return true;
  if (!x || !y) return !x && !y;
  if (x.kind === 'static' && y.kind === 'static' && x.value !== y.value) return false;
  return patternsOverlap(a.slice(1), b.slice(1));
}

/** How specific one segment is: a fixed word, then the end of the path, then a param, then `*`. */
function segmentRank(segment: PatternSegment | undefined): number {
  if (!segment) return 2;
  return segment.kind === 'static' ? 3 : segment.kind === 'param' ? 1 : 0;
}

/**
 * Order two Hono paths most specific first, segment by segment: a fixed word
 * before a `:param`, a `:param` before `*`. The mount registers its routes in
 * this order.
 *
 * @param a - One path.
 * @param b - The other.
 * @returns Negative when `a` is more specific, positive when `b` is, else 0.
 */
export function compareRouteSpecificity(a: string, b: string): number {
  const [x, y] = [patternSegments(a), patternSegments(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const diff = segmentRank(y[i]) - segmentRank(x[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Refuse an app where a hand route takes, shadows or is shadowed by a path the
 * mount serves.
 *
 * Hono runs the first matching route, so the order routes were registered in
 * decides who answers a request two patterns both match. For each capability
 * path it refuses: a hand route on the same METHOD + path; a hand route
 * registered before it that matches any of its requests; a hand route
 * registered after it that is more specific on a request both match (the
 * capability would take it); and hand middleware (`ALL`) registered after it
 * on a path it covers, which would never run for the capability, unless
 * {@link SKIPPABLE_MIDDLEWARE} says why it has nothing to do there. Middleware
 * registered before the mount runs first, as for every route, and is not a
 * claim. The mount's own routes are never counted against each other.
 *
 * @param app - The built app, every route group mounted.
 * @param capabilities - What the mount serves.
 * @throws Naming every conflict.
 */
export function assertNoCapabilityRouteCollisions(
  app: Pick<Hono, 'routes'>,
  capabilities: readonly CapabilityDefinition[]
): void {
  const routes = app.routes.map((route, index) => ({
    index,
    label: `${route.method.toUpperCase()} ${route.path}`,
    method: route.method.toUpperCase(),
    path: route.path,
    shape: routeKey(route.method, route.path),
    segments: patternSegments(route.path),
    mounted: isMountRoute(route.handler),
  }));
  const served = capabilities.flatMap((capability) => {
    const surface = capability.surfaces.http;
    if (!surface) return [];
    const method = surface.method.toUpperCase();
    const path = honoPath(surface.path);
    const shape = routeKey(method, path);
    // The mount's own route on this METHOD + path, if the app mounted it.
    const own = routes.find((route) => route.mounted && route.shape === shape);
    return [{ capability, method, path, shape, own }];
  });
  const conflicts: string[] = [];
  for (const { capability, method, path, shape, own } of served) {
    const segments = patternSegments(path);
    const at = own?.index ?? -1;
    const name = `${shape} (${capability.id})`;
    for (const route of routes) {
      // The mount orders its own routes itself (static before param), so one
      // of them never shadows another.
      if (route.mounted) continue;
      if (route.method === 'ALL') {
        const skip = `${method} ${path} skips ${route.label}`;
        if (
          route.index > at &&
          patternsOverlap(segments, route.segments) &&
          !(skip in SKIPPABLE_MIDDLEWARE)
        ) {
          conflicts.push(`${name} skips middleware ${route.label}`);
        }
        continue;
      }
      if (route.method !== method || !patternsOverlap(segments, route.segments)) continue;
      if (route.shape === shape) conflicts.push(`${name} is claimed by ${route.label}`);
      else if (route.index < at) conflicts.push(`${name} is shadowed by ${route.label}`);
      else if (compareRouteSpecificity(route.path, path) <= 0) {
        conflicts.push(`${name} shadows ${route.label}`);
      }
    }
  }
  if (conflicts.length > 0) {
    throw new Error(
      `A hand route conflicts with a path a capability serves: ${conflicts.join('; ')}. ` +
        'Delete the hand route (the capability mount serves it), give one another path, ' +
        "or fold the middleware's check into the capability."
    );
  }
}
