/**
 * The spaces experiment (DOR-2740) and its one exception, the official space (spec
 * `official-community-space` D5), as the server's route gates.
 *
 * Every route that reaches a space (a Community on another server) sits behind one of the gates
 * below, mounted where DOR-2740 mounted its whole-feature gate: `/api/communities`,
 * `/api/community-connections` and `/api/cloud/communities`. While the experiment is off each
 * refuses with 404 {@link SPACES_DISABLED_CODE}, so a client can tell "this feature is off" from
 * "that space does not exist", except for what the official space needs. This machine's own
 * rooms never pass through here. Nothing is deleted while spaces are off: turning them back on
 * finds every connection where it was left.
 *
 * @module middleware/spaces-enabled
 */
import type { IncomingMessage } from 'node:http';
import type { HttpBindings } from '@hono/node-server';
import type { MiddlewareHandler } from 'hono';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import { spacesEnabled } from '../services/communities/spaces-config.js';
import { getOfficialSpace } from '../services/communities/remote/state.js';

export { spacesEnabled };

/** The `code` a space route answers with while the spaces experiment is off. */
export const SPACES_DISABLED_CODE = 'SPACES_DISABLED';

/**
 * `spaceReachable(ref)` (spec `official-community-space` D5): whether one space may be reached
 * right now. True while the spaces experiment is on, and for the official space whatever the
 * experiment says. Every space surface that names a connection asks this, not the experiment
 * alone.
 *
 * @param ref - The local connection ref.
 */
export function spaceReachable(ref: CommunityRef): boolean {
  return getOfficialSpace().reachable(ref);
}

/** The 404 body every space route answers with while spaces are off. */
const SPACES_DISABLED_BODY = {
  error: 'Spaces are switched off. Turn them on in Settings → Advanced → Experiments.',
  code: SPACES_DISABLED_CODE,
} as const;

/**
 * What a space gate asks about the official space (spec `official-community-space` D5). The
 * production answer is {@link getOfficialSpace}; a test passes its own.
 */
export interface SpaceAccess {
  /** `spaceReachable(ref)`: the experiment is on, or this is the official space. */
  reachable(ref: CommunityRef): boolean;
  /** Whether a typed link is the configured official link. */
  isOfficialLink(url: string): boolean;
  /** The official link's origin, or `null` when there is no official space. */
  origin(): string | null;
}

/** What a space gate decided about one request. */
type GateDecision =
  /** Refuse it with {@link SPACES_DISABLED_BODY}. */
  | { pass: false }
  /** Let it through; `officialOrigin` is set when only the official space may be answered. */
  | { pass: true; officialOrigin?: string };

/**
 * Names the connection a request is about (its `:ref`), `'official-only'` for a request the
 * router itself narrows to the official space, or `null` for one that stays off.
 */
type GateRule = (
  method: string,
  segments: readonly string[],
  body: unknown,
  access: SpaceAccess
) => string | null;

/**
 * Decide one space router's gate (spec `official-community-space` D5). DOR-2740 gated each of
 * these routers whole at its mount; this keeps that mount and the same refusal, and lets
 * through, while the experiment is off, only what the official space needs. A `:ref` passes
 * only when `spaceReachable(ref)` says so, so a route added later under a ref is covered by
 * construction, and one added without a ref is off until the rule says otherwise.
 *
 * @param rule - What this router lets through for the official space.
 * @param method - The request method, as sent (`HEAD` is not `GET`).
 * @param path - The request path below the router's mount.
 * @param body - The parsed request body, for a rule that reads one.
 * @param access - The official-space answer.
 */
function decideSpaceGate(
  rule: GateRule,
  method: string,
  path: string,
  body: unknown,
  access: SpaceAccess
): GateDecision {
  if (spacesEnabled()) return { pass: true };
  // No official space configured: the exception is dormant and every request refuses, exactly
  // as DOR-2740 shipped it.
  const origin = access.origin();
  if (origin === null) return { pass: false };
  const decision = rule(method, path.split('/').filter(Boolean), body, access);
  if (decision === 'official-only') return { pass: true, officialOrigin: origin };
  if (decision !== null && access.reachable(decision as CommunityRef)) return { pass: true };
  return { pass: false };
}

/**
 * The official space's origin, for a request a gate let through for the official space alone.
 * Keyed by the raw request, so nothing outlives it.
 */
const officialOrigins = new WeakMap<IncomingMessage, string>();

/**
 * What a space gate reads: the raw Node request, and the body the chain parsed (`c.var.body`,
 * `http/request-body.ts`), for a rule that reads one.
 */
type SpaceGateEnv = { Bindings: HttpBindings; Variables: { body?: unknown } };

/**
 * One space router's gate on the Hono chain; see {@link decideSpaceGate}. Mount it with
 * `use('<mount>/*', …)`: it reads the path below that mount, so it covers the mount itself and
 * every path under it, a route there or not.
 */
function spaceGate<E extends SpaceGateEnv>(
  rule: GateRule,
  access: () => SpaceAccess
): MiddlewareHandler<E> {
  return async (c, next) => {
    const mount = c.req.routePath.replace(/\/\*$/, '');
    const below = c.req.path.slice(mount.length);
    const decision = decideSpaceGate(rule, c.req.method, below, c.get('body'), access());
    if (!decision.pass) return c.json(SPACES_DISABLED_BODY, 404);
    if (decision.officialOrigin !== undefined) {
      officialOrigins.set(c.env.incoming, decision.officialOrigin);
    }
    await next();
  };
}

/** The `ref` a JSON body names, or `null`. */
function bodyRef(body: unknown): string | null {
  const ref = (body as { ref?: unknown } | undefined)?.ref;
  return typeof ref === 'string' && ref ? ref : null;
}

/**
 * Gate for `/api/community-connections` while spaces are off: the list (narrowed to the official
 * row), starting a pairing from the official link only, the navigation reads and writes about
 * the official space, and every `/:ref` route for the official connection.
 *
 * @param access - The official-space answer, read per request.
 */
export function gateCommunityConnections<E extends SpaceGateEnv>(
  access: () => SpaceAccess = getOfficialSpace
): MiddlewareHandler<E> {
  return spaceGate((method, segments, body, current) => {
    if (segments.length === 0) {
      if (method === 'GET') return 'official-only';
      if (method === 'POST') {
        const url = (body as { url?: unknown } | undefined)?.url;
        return typeof url === 'string' && current.isOfficialLink(url) ? 'official-only' : null;
      }
      return null;
    }
    if (segments[0] === 'navigation') {
      const [, second, third] = segments;
      if (segments.length === 1) return method === 'GET' ? 'official-only' : null;
      if (segments.length === 2 && second === 'installation')
        return method === 'PUT' ? 'official-only' : null;
      if (segments.length === 2 && (second === 'move' || second === 'destination'))
        return bodyRef(body);
      if (segments.length === 3 && third === 'destination') return second ?? null;
      return null;
    }
    return segments[0] ?? null;
  }, access);
}

/**
 * Gate for `/api/communities`: every route there names a connection as its first segment, so
 * with spaces off only the official one answers.
 *
 * @param access - The official-space answer, read per request.
 */
export function gateRemoteCommunities<E extends SpaceGateEnv>(
  access: () => SpaceAccess = getOfficialSpace
): MiddlewareHandler<E> {
  return spaceGate((_method, segments) => segments[0] ?? null, access);
}

/**
 * Gate for `/api/cloud/communities`: with spaces off only `GET /sign-in` answers, and only about
 * the official space's server. Starting, hosting and moving spaces stay off.
 *
 * @param access - The official-space answer, read per request.
 */
export function gateCloudCommunities<E extends SpaceGateEnv>(
  access: () => SpaceAccess = getOfficialSpace
): MiddlewareHandler<E> {
  return spaceGate(
    (method, segments) =>
      method === 'GET' && segments.length === 1 && segments[0] === 'sign-in'
        ? 'official-only'
        : null,
    access
  );
}

/**
 * The official space's origin when a space gate let this request through for it alone, or
 * `null` when spaces are on. A route that answers with a list narrows it to the official space
 * when this is set, so the gate and the route agree on one rule without the route reading config
 * itself.
 *
 * @param c - The request's context.
 */
export function officialOnlyOrigin(c: { env: HttpBindings }): string | null {
  return officialOrigins.get(c.env.incoming) ?? null;
}
