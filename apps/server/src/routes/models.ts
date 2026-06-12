import { Router } from 'express';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { asyncHandler } from '../lib/async-handler.js';

const router = Router();

/**
 * GET /api/models — list available models for the resolved runtime.
 *
 * Accepts an optional `sessionId` query parameter. When provided, the route
 * resolves the runtime owning that session (per `session_metadata`). When
 * absent, falls back to the default runtime — this is a legitimate
 * cold-discovery path for screens without session context (onboarding,
 * first-run, agent creation).
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    const runtime = sessionId
      ? await runtimeRegistry.resolveForSession(sessionId)
      : // cold discovery: no session context (onboarding, first-run)
        runtimeRegistry.getDefault();
    const models = await runtime.getSupportedModels();
    res.json({ models });
  })
);

export default router;
