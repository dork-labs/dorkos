/**
 * What the app's sign-in landing page reads (`/signed-in?landing=<id>`): the
 * record an OAuth callback left (`services/core/sign-in-landing/sign-in-landings.ts`), and Try
 * again, which starts the same sign-in once more.
 *
 * Both are **this-computer only**, like the callbacks that write the records:
 * the browser that signed in is the person's own, on this machine. Neither
 * route echoes anything a caller sent; a record's words were written by the
 * server, and a failed restart answers with a fixed sentence while the cause
 * goes to the log.
 *
 * @module routes/sign-in-landings
 */
import { Hono, type Context } from 'hono';
import { problem } from '@dorkos/http-kit';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { isAtThisComputer } from '../services/core/auth/gate-policy.js';
import {
  signInLandings as defaultLandings,
  type SignInLandingStore,
} from '../services/core/sign-in-landing/sign-in-landings.js';
import { logger } from '../lib/logger.js';

/** The answer when the record is gone (expired, or never written). */
function gone(c: Context): Response {
  return problem(c, 'expired', { detail: 'This sign-in page expired.', status: 404 });
}

/**
 * Build the routes mounted at `/api/sign-in-landings`.
 *
 * @param landings - The landing store; the server's own unless a test passes one.
 * @returns `GET /:id` and `POST /:id/retry`.
 */
export function createSignInLandingRoutes(
  landings: SignInLandingStore = defaultLandings
): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.use('*', async (c, next) => {
    if (!isAtThisComputer(honoRequestFacts(c))) {
      return problem(c, 'operator_only', { detail: 'Open this on the computer DorkOS runs on.' });
    }
    return next();
  });

  router.get('/:id', (c) => {
    const landing = landings.get(c.req.param('id'));
    if (!landing) return gone(c);
    c.header('Cache-Control', 'no-store');
    return c.json(landing);
  });

  router.post('/:id/retry', async (c) => {
    const id = c.req.param('id');
    if (!landings.get(id)) return gone(c);
    const restarted = landings.retry(id);
    if (!restarted) {
      return problem(c, 'signin_no_retry', { detail: 'This sign-in can’t start again here.' });
    }
    try {
      return c.json(await restarted);
    } catch (err) {
      logger.warn('[sign-in-landings] Try again could not start the sign-in', {
        reason: err instanceof Error ? err.message : String(err),
      });
      return problem(c, 'upstream_unavailable', { detail: 'Couldn’t start the sign-in again.' });
    }
  });

  return router;
}
