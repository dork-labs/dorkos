/**
 * `GET /api/agents/:id/heartbeat` (spec `heartbeats` §7.6): what the agent's
 * Heartbeat page shows — how it wakes, its next beat, its last beats from the
 * record, and the raises held for people's hours. Readable by anyone in the
 * space, like the record it reads.
 *
 * @module routes/heartbeats
 */
import { Router, type Request, type Response } from 'express';
import type { HeartbeatStatus } from '@dorkos/shared/heartbeat-schemas';

/** What the heartbeat route needs. */
export interface HeartbeatRouterDeps {
  /**
   * The agent's status, or undefined when no such agent exists.
   *
   * @param agentId - The agent's Mesh id.
   * @param viewerIsOwner - Whether the caller owns this install: only they see
   *   held raises' words and which chat a beat ran in.
   */
  status(agentId: string, viewerIsOwner: boolean): Promise<HeartbeatStatus | undefined>;
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
    const status = await deps.status(agentId, deps.isOwner(req, res));
    if (!status)
      return res.status(404).json({ error: 'No agent with that id.', code: 'NOT_FOUND' });
    return res.json(status);
  });
  return router;
}
