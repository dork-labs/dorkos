/**
 * `GET /api/heartbeats/wakers-off` (DOR-3641): every schedule and heartbeat
 * that cannot wake now, since when, and who it waits on, for the team page.
 * Readable by anyone who can read the task list, which already shows each
 * schedule's state.
 *
 * @module routes/wakers-off
 */
import { Hono } from 'hono';
import type { WakersOff } from '@dorkos/shared/waker-schemas';
import type { ApiEnv } from '../http/api-chain.js';

/** What the route needs. */
export interface WakersOffRouterDeps {
  /** Every waker that cannot wake now. */
  list(): Promise<WakersOff>;
}

/**
 * Build the route, mounted at `/api/heartbeats/wakers-off`.
 *
 * @param deps - Where the list comes from.
 */
export function createWakersOffRoutes(deps: WakersOffRouterDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  router.get('/', async (c) => c.json(await deps.list()));
  return router;
}
