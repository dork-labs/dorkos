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
 * A hand route may not claim a capability's METHOD + path:
 * {@link assertNoCapabilityRouteCollisions} throws when the app is built.
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
import { dispatchCapability } from './capability-dispatch.js';
import { readJsonBody } from '@dorkos/http-kit';
import { readQuery } from '../http/request-query.js';

/**
 * Capabilities whose declared path a hand route still serves, each with the
 * reason. The mount skips them, so the hand route is the only claim on the path.
 * Each entry leaves this list in the change that deletes its hand route; none
 * may join it.
 */
export const HAND_SERVED_CAPABILITIES: Readonly<Record<string, string>> = Object.freeze({
  'operator.activity_list': 'routes/activity.ts; moves onto the mount with the activity domain',
  'audit.verify': 'routes/audit.ts; moves onto the mount with the audit domain',
  'audit.query': 'routes/audit.ts; moves onto the mount with the audit domain',
  'audit.get': 'routes/audit.ts; moves onto the mount with the audit domain',
  'audit.account_timeline': 'routes/audit.ts; moves onto the mount with the audit domain',
  'audit.running_chats': 'routes/running-chats.ts; moves onto the mount with the audit domain',
  'rooms.reseat_options': 'routes/room-reseat.ts; moves onto the mount with the rooms domain',
  'rooms.reseat': 'routes/room-reseat.ts; moves onto the mount with the rooms domain',
  'capabilities.list': 'routes/capabilities-catalog.ts; moves onto the mount with its page shape',
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
  for (const capability of deps.capabilities) {
    const surface = capability.surfaces.http;
    if (!surface) continue;
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
    router.on(surface.method.toUpperCase(), path, (c) => {
      const registry = deps.registry();
      // The path is declared on every server, but its domain may not have
      // started on this one (no mesh, say): not here, rather than "unknown".
      if (registry && !registry.get(served.id)) {
        return c.json({ error: NOT_ON_THIS_COMPUTER, code: 'UNKNOWN_CAPABILITY' }, 404);
      }
      return dispatchCapability(c, {
        registry,
        id: served.id,
        input: requestInput(c, surface),
        ...(surface.success ? { success: surface.success } : {}),
      });
    });
  }
  return router;
}

/**
 * Refuse an app where a hand route claims a path the mount serves.
 *
 * Hono runs the first matching route, so a hand route on a capability's path
 * would silently take its requests, or silently lose them, by mount order.
 * Middleware (`ALL` entries) is not a claim.
 *
 * @param app - The built app, every route group mounted.
 * @param capabilities - What the mount serves.
 * @throws Naming every path claimed twice.
 */
export function assertNoCapabilityRouteCollisions(
  app: Pick<Hono, 'routes'>,
  capabilities: readonly CapabilityDefinition[]
): void {
  const counts = new Map<string, number>();
  for (const route of app.routes) {
    if (route.method === 'ALL') continue;
    const key = routeKey(route.method, route.path);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const collisions: string[] = [];
  for (const capability of capabilities) {
    const surface = capability.surfaces.http;
    if (!surface) continue;
    const key = routeKey(surface.method, honoPath(surface.path));
    if ((counts.get(key) ?? 0) > 1) collisions.push(`${key} (${capability.id})`);
  }
  if (collisions.length > 0) {
    throw new Error(
      `A hand route claims a path a capability serves: ${collisions.join(', ')}. ` +
        'Delete the hand route; the capability mount serves it.'
    );
  }
}
