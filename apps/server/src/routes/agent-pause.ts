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
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { CANNOT_RESUME_SELF_CODE } from '@dorkos/shared/mesh-schemas';
import {
  CapabilityGateRefusal,
  CapabilityToolError,
  type CapabilityRegistry,
} from '../services/core/capabilities/index.js';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { logger } from '../lib/logger.js';

/** What the routes need, read lazily: the registry is composed after the routes mount. */
export interface AgentPauseRouterDeps {
  /** The composed capability registry, or `undefined` before boot finishes. */
  registry: () => CapabilityRegistry | undefined;
}

/** The status each refusal code answers with. */
function statusForCode(code: unknown): 403 | 404 | 400 {
  if (code === CANNOT_RESUME_SELF_CODE) return 403;
  if (code === 'AGENT_NOT_FOUND') return 404;
  return 400;
}

/**
 * The pause routes, to mount at `/api`. Only these concrete paths are
 * registered, so the group answers nothing else under `/api`.
 *
 * @param deps - The registry, read per request.
 * @returns The routes serving `/agents/pauses` and `/agents/:id/{pause,resume}`.
 */
export function createAgentPauseRoutes(deps: AgentPauseRouterDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  /** Invoke one capability as the request's caller, answering its result or refusal. */
  async function invoke(
    c: Context<ApiEnv>,
    capabilityId: string,
    input: Record<string, unknown>
  ): Promise<Response> {
    const registry = deps.registry();
    if (!registry) {
      return c.json({ error: 'DorkOS is still starting. Try again.', code: 'NOT_READY' }, 503);
    }
    const facts = honoRequestFacts(c);
    const identity = facts.agentIdentity;
    const agentIdentityPresented = presentsAgentIdentity(facts);
    const user = facts.user;
    try {
      const result = await registry.invoke(capabilityId, input, {
        ...(identity ? { identity } : {}),
        ...(agentIdentityPresented ? { agentIdentityPresented } : {}),
        ...(user ? { userId: user.userId } : {}),
        retryChannel: 'http-header',
      });
      return c.json(result);
    } catch (err) {
      if (err instanceof CapabilityGateRefusal) {
        const status = err.decision.outcome === 'approval_required' ? 202 : 403;
        return c.json(err.decision.payload, status);
      }
      if (err instanceof z.ZodError) {
        return c.json({ error: 'Validation failed', details: z.flattenError(err) }, 400);
      }
      if (err instanceof CapabilityToolError) {
        const payload = (err.payload ?? {}) as { code?: unknown };
        return c.json(payload, statusForCode(payload.code));
      }
      logger.error('[agent-pause] invoke failed', { capabilityId, err });
      return c.json({ error: 'Internal server error' }, 500);
    }
  }

  /** The optional reason from a body that may be absent. */
  const reasonOf = (c: Context<ApiEnv>): Record<string, unknown> => {
    const reason = (readJsonBody(c) as { reason?: unknown } | undefined)?.reason;
    return reason === undefined ? {} : { reason };
  };

  router.get('/agents/pauses', (c) => invoke(c, 'agent.list_paused', {}));

  router.post('/agents/:id/pause', (c) =>
    invoke(c, 'agent.pause', { agentId: c.req.param('id'), ...reasonOf(c) })
  );

  router.post('/agents/:id/resume', (c) =>
    invoke(c, 'agent.resume', { agentId: c.req.param('id'), ...reasonOf(c) })
  );

  return router;
}
