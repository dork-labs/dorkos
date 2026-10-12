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
import type { MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { refuseAgentExecutionWrite } from '../services/core/operator/agent-execution.js';
import { clearsTheAgentBar } from '../lib/caller-authority.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';

/**
 * Refuse a request that names `runtime`, `model` or `effort` unless its caller
 * is a person, with `403 NEEDS_APPROVAL`; every other request passes through
 * untouched.
 *
 * @param c - The Hono context.
 * @param next - The route's handler.
 */
export const refuseAgentExecutionWrites: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const refusal = refuseAgentExecutionWrite(readJsonBody(c), () =>
    clearsTheAgentBar(honoRequestFacts(c))
  );
  if (refusal) return c.json(refusal.body, refusal.status as ContentfulStatusCode);
  await next();
};
