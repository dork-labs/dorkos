/**
 * Pause an agent everywhere, and lift the pause (spec `audit-trail` PR5).
 *
 * - `GET  /api/agents/pauses`        every agent paused right now
 * - `POST /api/agents/:id/pause`     pause one (`{ reason? }`)
 * - `POST /api/agents/:id/resume`    lift its pause (`{ reason? }`)
 *
 * Each route invokes its capability (`agent.list_paused`, `agent.pause`,
 * `agent.resume`) through the registry, exactly as `dorkos call` and both MCP
 * servers do, so the tier gate, the caller's identity and the audit record are
 * the same whichever surface asked. A person may call any of them; so may any
 * agent, except that a paused agent can never lift its own pause (`403
 * CANNOT_RESUME_SELF`). Mounted at `/api`, before the agents router.
 *
 * @module routes/agent-pause
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { CANNOT_RESUME_SELF_CODE } from '@dorkos/shared/mesh-schemas';
import {
  CapabilityGateRefusal,
  CapabilityToolError,
  type CapabilityRegistry,
} from '../services/core/capabilities/index.js';
import { getRequestAgentIdentity, presentsAgentIdentity } from '../middleware/agent-identity.js';
import type { RequestUser } from '../services/core/auth/index.js';
import { logger } from '../lib/logger.js';

/** What the routes need, read lazily: the registry is composed after the routes mount. */
export interface AgentPauseRouterDeps {
  /** The composed capability registry, or `undefined` before boot finishes. */
  registry: () => CapabilityRegistry | undefined;
}

/** The status each refusal code answers with. */
function statusForCode(code: unknown): number {
  if (code === CANNOT_RESUME_SELF_CODE) return 403;
  if (code === 'AGENT_NOT_FOUND') return 404;
  return 400;
}

/**
 * Build the pause router.
 *
 * @param deps - The registry, read per request.
 */
export function createAgentPauseRouter(deps: AgentPauseRouterDeps): Router {
  const router = Router();

  /** Invoke one capability as the request's caller, answering its result or refusal. */
  async function invoke(
    req: Request,
    res: Response,
    capabilityId: string,
    input: Record<string, unknown>
  ): Promise<void> {
    const registry = deps.registry();
    if (!registry) {
      res.status(503).json({ error: 'DorkOS is still starting. Try again.', code: 'NOT_READY' });
      return;
    }
    const identity = getRequestAgentIdentity(res);
    const agentIdentityPresented = presentsAgentIdentity(req, res);
    const user = res.locals.user as RequestUser | undefined;
    try {
      const result = await registry.invoke(capabilityId, input, {
        ...(identity ? { identity } : {}),
        ...(agentIdentityPresented ? { agentIdentityPresented } : {}),
        ...(user ? { userId: user.userId } : {}),
        retryChannel: 'http-header',
      });
      res.json(result);
    } catch (err) {
      if (err instanceof CapabilityGateRefusal) {
        const status = err.decision.outcome === 'approval_required' ? 202 : 403;
        res.status(status).json(err.decision.payload);
        return;
      }
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Validation failed', details: z.flattenError(err) });
        return;
      }
      if (err instanceof CapabilityToolError) {
        const payload = (err.payload ?? {}) as { code?: unknown };
        res.status(statusForCode(payload.code)).json(payload);
        return;
      }
      logger.error('[agent-pause] invoke failed', { capabilityId, err });
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /** The optional reason from a body Express 5 may leave undefined. */
  const reasonOf = (req: Request): Record<string, unknown> => {
    const reason = (req.body as { reason?: unknown } | undefined)?.reason;
    return reason === undefined ? {} : { reason };
  };

  router.get('/agents/pauses', (req, res) => invoke(req, res, 'agent.list_paused', {}));

  router.post('/agents/:id/pause', (req, res) =>
    invoke(req, res, 'agent.pause', { agentId: req.params.id, ...reasonOf(req) })
  );

  router.post('/agents/:id/resume', (req, res) =>
    invoke(req, res, 'agent.resume', { agentId: req.params.id, ...reasonOf(req) })
  );

  return router;
}
