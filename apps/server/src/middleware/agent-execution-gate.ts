/**
 * Route guard for an agent's runtime, model and effort (DOR-2328).
 *
 * Mounted on the two routes that edit an agent's manifest, `PATCH
 * /api/agents/current` and `PATCH /api/mesh/agents/:id`, ahead of their
 * handlers, so the refusal comes before anything is read or written. The
 * reasoning, and who is and is not asked, lives with the rule it enforces in
 * `services/core/operator/agent-execution.ts`.
 *
 * @module middleware/agent-execution-gate
 */
import type { Request, Response, NextFunction } from 'express';
import { refuseAgentExecutionWrite } from '../services/core/operator/agent-execution.js';
import { clearsTheAgentBar } from '../lib/caller-authority.js';

/**
 * Refuse a request that names `runtime`, `model` or `effort` unless its caller
 * is a person; every other request passes through untouched.
 *
 * Generic over the route's params so mounting it ahead of a handler leaves
 * Express's inference of `req.params` for that handler intact.
 *
 * @param req - The request.
 * @param res - The response, answered with `403 NEEDS_APPROVAL` on a refusal.
 * @param next - Called when the request may go on.
 */
export function refuseAgentExecutionWrites<P>(
  req: Request<P>,
  res: Response,
  next: NextFunction
): void {
  const refusal = refuseAgentExecutionWrite(req.body, () => clearsTheAgentBar(req as Request, res));
  if (refusal) {
    res.status(refusal.status).json(refusal.body);
    return;
  }
  next();
}
