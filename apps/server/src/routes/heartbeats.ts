/**
 * `GET /api/agents/:id/heartbeat` (spec `heartbeats` §7.6, §13): what the
 * agent's Heartbeat page shows — how it wakes, its next beat, its last 50 beats
 * from the record, the raises held for people's hours, and its measures over
 * `?days=` (default 7, at most 90). Readable by anyone in the space, like the
 * record it reads.
 *
 * @module routes/heartbeats
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { HeartbeatStatus } from '@dorkos/shared/heartbeat-schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { refuseUnlessAccountOwner } from '../lib/caller-authority.js';

/** `?days=`: the measures' window, 1 to 90 whole days, or absent for the default. */
const DaysQuerySchema = z.coerce.number().int().min(1).max(90).optional();

/** What the heartbeat route needs. */
export interface HeartbeatRouterDeps {
  /**
   * The agent's status, or undefined when no such agent exists.
   *
   * @param agentId - The agent's Mesh id.
   * @param viewerIsOwner - Whether the caller owns this install: only they see
   *   held raises' words and which chat a beat ran in.
   * @param days - The measures' window, when the caller named one.
   */
  status(
    agentId: string,
    viewerIsOwner: boolean,
    days?: number
  ): Promise<HeartbeatStatus | undefined>;
}

/**
 * Build the routes, mounted at `/api/agents/:id/heartbeat`.
 *
 * @param deps - Where the status comes from.
 */
export function createHeartbeatRoutes(deps: HeartbeatRouterDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  router.get('/', async (c) => {
    const days = DaysQuerySchema.safeParse(c.req.query('days'));
    if (!days.success) {
      return c.json(
        { error: 'days must be a whole number from 1 to 90.', code: 'INVALID_DAYS' },
        400
      );
    }
    const viewerIsOwner = refuseUnlessAccountOwner(honoRequestFacts(c)) === undefined;
    const status = await deps.status(c.req.param('id') ?? '', viewerIsOwner, days.data);
    if (!status) return c.json({ error: 'No agent with that id.', code: 'NOT_FOUND' }, 404);
    return c.json(status);
  });
  return router;
}
