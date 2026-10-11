/**
 * `GET /api/agents/:id/heartbeat` (spec `heartbeats` §7.6, §13): what the
 * agent's Heartbeat page shows — how it wakes, its next beat, its last 50 beats
 * from the record, the raises held for people's hours, and its measures over
 * `?days=` (default 7, at most 90). Readable by anyone in the space, like the
 * record it reads.
 *
 * @module routes/heartbeats
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { HeartbeatStatus } from '@dorkos/shared/heartbeat-schemas';

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
  /**
   * Whether this caller owns this install.
   *
   * @param req - The request.
   * @param res - The response, carrying the resolved caller.
   */
  isOwner(req: Request, res: Response): boolean;
}

/**
 * Build the router, mounted at `/api/agents/:id/heartbeat`.
 *
 * @param deps - Where the status comes from.
 */
export function createHeartbeatRouter(deps: HeartbeatRouterDeps): Router {
  const router = Router({ mergeParams: true });
  router.get('/', async (req, res) => {
    const agentId = (req.params as { id?: string }).id ?? '';
    const days = DaysQuerySchema.safeParse(req.query.days);
    if (!days.success) {
      return res
        .status(400)
        .json({ error: 'days must be a whole number from 1 to 90.', code: 'INVALID_DAYS' });
    }
    const status = await deps.status(agentId, deps.isOwner(req, res), days.data);
    if (!status)
      return res.status(404).json({ error: 'No agent with that id.', code: 'NOT_FOUND' });
    return res.json(status);
  });
  return router;
}
