/**
 * Moved route groups on the real `/api` chain, for a test that hands a group
 * its own fakes rather than booting the whole server.
 *
 * The groups answer behind the same chain they run behind in production (body
 * parsing, the session gate, agent identity, the error handler and the `/api`
 * 404). A test that needs a caller the chain could not resolve on its own
 * passes `before`, which runs after the chain and before the groups, where an
 * Express test put its `res.locals` stub. A test that also drives a router
 * still on Express passes it as `legacy`, and gets the front door in front of
 * both, as the running server has.
 */
import type { RequestListener } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import type { Hono, MiddlewareHandler } from 'hono';
import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
import { createApiApp, type ApiEnv } from '../api-chain.js';
import type { BodyRule } from '../request-body.js';
import { createFrontDoor, frontDoorListener } from '../front-door.js';

/** One group to mount: where, and its routes. */
export interface MountedGroup {
  /** The mount path, as `http/hono-api.ts` mounts it. */
  path: string;
  /** The group's routes. */
  routes: Hono<ApiEnv>;
}

/** Options for {@link honoGroupListener}. */
export interface HonoGroupListenerOptions {
  /** Middleware between the chain and the groups. */
  before?: MiddlewareHandler<ApiEnv>;
  /** An Express app answering whatever the groups do not, behind the front door. */
  legacy?: RequestListener;
  /**
   * Routes registered before the body is parsed and before the session gate,
   * as `http/hono-api.ts` registers Better Auth and the signed webhook ingress.
   */
  beforeBodyParsing?: (app: Hono<ApiEnv>) => void;
  /** Path-scoped body parsers, as `http/hono-api.ts` hands the chain its own. */
  bodyRules?: readonly BodyRule[];
}

/**
 * A Node request listener serving `groups` behind the `/api` chain.
 *
 * @param groups - The groups, mounted in this order.
 * @param options - See {@link HonoGroupListenerOptions}.
 * @returns The listener.
 */
export function honoGroupListener(
  groups: MountedGroup | readonly MountedGroup[],
  options: HonoGroupListenerOptions = {}
): RequestListener {
  const app = createApiApp({
    admission: new MainRequestAdmission(),
    beforeBodyParsing: options.beforeBodyParsing,
    bodyRules: options.bodyRules,
  });
  if (options.before) app.use(options.before);
  const list: readonly MountedGroup[] = 'path' in groups ? [groups] : groups;
  for (const group of list) app.route(group.path, group.routes);
  if (options.legacy) return frontDoorListener(createFrontDoor(options.legacy, { api: app }));
  return getRequestListener(app.fetch, { overrideGlobalObjects: false });
}
