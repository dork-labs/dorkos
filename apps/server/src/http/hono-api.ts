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

/** Options for {@link createHonoApi}. */
export interface HonoApiOptions {
  /** The main listener's shared terminal state. */
  admission: MainRequestAdmission;
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
  return createApiApp({
    admission: options.admission,
    beforeBodyParsing: (app) => {
      if (auth) mountBetterAuth(app, { auth, maxAttempts: env.DORKOS_AUTH_SIGNIN_RATE_LIMIT });
    },
  });
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
 * @returns The front door, for `createFrontDoorServer` or `frontDoorListener`.
 */
export function composeFrontDoor(
  legacy: RequestListener,
  admission: MainRequestAdmission
): FrontDoor {
  return createFrontDoor(legacy, {
    api: createHonoApi({ admission }),
    census: env.DORKOS_TEST_RUNTIME,
  });
}
