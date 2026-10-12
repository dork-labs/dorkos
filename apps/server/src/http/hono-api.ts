/**
 * The Hono half of the server: the `/api` chain with every route group that
 * has moved off Express mounted on it (`plans/2026-10-express-to-hono.md`).
 *
 * {@link composeFrontDoor} hands it to the front door, which claims its routes
 * ahead of the Express fallthrough (`http/front-door.ts`). `index.ts` serves
 * that, and tests that need the server's real routing build the same thing.
 * Each move PR mounts its group here and deletes the group's Express router in
 * the same change.
 *
 * @module http/hono-api
 */
import type { RequestListener } from 'node:http';
import type { Hono } from 'hono';
import { env } from '../env.js';
import { getAuth } from '../services/core/auth/index.js';
import type { MainRequestAdmission } from '../services/core/lifecycle/main-request-admission.js';
import { createApiApp, type ApiEnv } from './api-chain.js';
import { mountBetterAuth } from './better-auth.js';
import { createFrontDoor, type FrontDoor } from './front-door.js';
import { createApiDocsRoutes } from '../routes/api-docs.js';
import commandRoutes from '../routes/commands.js';
import errorRoutes from '../routes/errors.js';
import { createHealthRoutes, type HealthRouteDeps } from '../routes/health.js';
import keepAwakeRoutes from '../routes/keep-awake.js';
import modelRoutes from '../routes/models.js';
import subagentRoutes from '../routes/subagents.js';
import { createSystemRoutes, type SystemRouteDeps } from '../routes/system.js';

/** What the moved route groups read from the running server, handed over by `index.ts`. */
export type HonoApiDeps = HealthRouteDeps & SystemRouteDeps;

/** Options for {@link createHonoApi}. */
export interface HonoApiOptions {
  /** The main listener's shared terminal state. */
  admission: MainRequestAdmission;
  /** See {@link HonoApiDeps}. A test that builds the server bare passes none. */
  deps?: HonoApiDeps;
}

/**
 * Build the Hono `/api` app with every moved group mounted.
 *
 * Better Auth is mounted whenever `initAuth` has run, even with login off, so
 * the enable-login flow can create the owner account before the flag flips. A
 * unit test that builds the server without auth gets no auth routes.
 *
 * @param options - See {@link HonoApiOptions}.
 * @returns The app, ready for `createFrontDoor({ api })`.
 */
export function createHonoApi(options: HonoApiOptions): Hono<ApiEnv> {
  const auth = getAuth();
  const deps = options.deps ?? {};
  const app = createApiApp({
    admission: options.admission,
    beforeBodyParsing: (early) => {
      if (auth) mountBetterAuth(early, { auth, maxAttempts: env.DORKOS_AUTH_SIGNIN_RATE_LIMIT });
    },
  });
  app.route('/api/health', createHealthRoutes(deps));
  app.route('/api/models', modelRoutes);
  app.route('/api/commands', commandRoutes);
  app.route('/api/subagents', subagentRoutes);
  app.route('/api/system', createSystemRoutes(deps));
  app.route('/api/keep-awake', keepAwakeRoutes);
  app.route('/api/errors', errorRoutes);
  app.route('/api', createApiDocsRoutes());
  return app;
}

/**
 * The server's routing: the front door, with the Hono `/api` app claiming its
 * routes and `legacy` answering the rest. A test server also serves the route
 * census.
 *
 * Build it after `initAuth`, as `index.ts` does, or the Hono app has no auth
 * routes.
 *
 * @param legacy - The Express app from `createApp`.
 * @param admission - The main listener's shared terminal state.
 * @param deps - What the moved groups read; see {@link HonoApiDeps}.
 * @returns The front door, for `createFrontDoorServer` or `frontDoorListener`.
 */
export function composeFrontDoor(
  legacy: RequestListener,
  admission: MainRequestAdmission,
  deps?: HonoApiDeps
): FrontDoor {
  return createFrontDoor(legacy, {
    api: createHonoApi({ admission, deps }),
    census: env.DORKOS_TEST_RUNTIME,
  });
}
