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
import { Hono } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { isAtThisComputer } from '../services/core/auth/gate-policy.js';
import {
  signInLandings as defaultLandings,
  type SignInLandingStore,
} from '../services/core/sign-in-landing/sign-in-landings.js';
import { logger } from '../lib/logger.js';

/** The answer when the record is gone (expired, or never written). */
const GONE = { error: 'This sign-in page expired.', code: 'SIGNIN_LANDING_GONE' } as const;

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
      return c.json({ error: 'Not available.', code: 'NOT_AT_THIS_COMPUTER' }, 403);
    }
    return next();
  });

  router.get('/:id', (c) => {
    const landing = landings.get(c.req.param('id'));
    if (!landing) return c.json(GONE, 404);
    c.header('Cache-Control', 'no-store');
    return c.json(landing);
  });

  router.post('/:id/retry', async (c) => {
    const id = c.req.param('id');
    if (!landings.get(id)) return c.json(GONE, 404);
    const restarted = landings.retry(id);
    if (!restarted) {
      return c.json(
        { error: 'This sign-in can’t start again here.', code: 'SIGNIN_NO_RETRY' },
        409
      );
    }
    try {
      return c.json(await restarted);
    } catch (err) {
      logger.warn('[sign-in-landings] Try again could not start the sign-in', {
        reason: err instanceof Error ? err.message : String(err),
      });
      return c.json(
        { error: 'Couldn’t start the sign-in again.', code: 'SIGNIN_RETRY_FAILED' },
        502
      );
    }
  });

  return router;
}
