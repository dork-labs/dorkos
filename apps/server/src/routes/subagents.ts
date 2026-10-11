import { Hono } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import { readQuery } from '../http/request-query.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';

const router = new Hono<ApiEnv>();

/**
 * GET /api/subagents — list available subagents reported by the resolved runtime.
 *
 * Accepts an optional `sessionId` query parameter. When provided, the route
 * resolves the runtime owning that session (per `session_metadata`). When
 * absent, falls back to the default runtime — this is a legitimate
 * cold-discovery path for screens without session context (onboarding,
 * first-run, agent creation).
 */
router.get('/', async (c) => {
  const query = readQuery(c);
  const sessionId = typeof query.sessionId === 'string' ? query.sessionId : undefined;
  const runtime = sessionId
    ? await runtimeRegistry.resolveForSession(sessionId)
    : // cold discovery: no session context (onboarding, first-run)
      runtimeRegistry.getDefault();
  const subagents = await runtime.getSupportedSubagents();
  return c.json({ subagents });
});

export default router;
