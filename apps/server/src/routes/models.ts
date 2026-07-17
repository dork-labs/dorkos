import { Router } from 'express';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { runtimeRegistry } from '../services/core/runtime-registry.js';

const router = Router();

/**
 * GET /api/models — list available models for the resolved runtime.
 *
 * Resolution priority:
 * 1. An explicit `runtime` query param — validated against the registry (400 on
 *    unknown). This is the not-yet-started-session path: a brand-new session has
 *    no `session_metadata` row, so resolving by `sessionId` alone would infer
 *    the default (`claude-code`) and wrongly show Anthropic models for a Codex
 *    session before its first message.
 * 2. Else a `sessionId` — resolves the runtime owning that session.
 * 3. Else the default runtime — the legitimate cold-discovery path for screens
 *    without session context (onboarding, first-run, agent creation).
 */
router.get('/', async (req, res) => {
  const runtimeParam = typeof req.query.runtime === 'string' ? req.query.runtime : undefined;
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;

  let runtime: AgentRuntime;
  if (runtimeParam !== undefined) {
    if (!runtimeRegistry.has(runtimeParam)) {
      return res.status(400).json({ error: `Unknown runtime: ${runtimeParam}` });
    }
    runtime = runtimeRegistry.get(runtimeParam);
  } else if (sessionId) {
    runtime = await runtimeRegistry.resolveForSession(sessionId);
  } else {
    // cold discovery: no session context (onboarding, first-run)
    runtime = runtimeRegistry.getDefault();
  }

  const models = await runtime.getSupportedModels();
  res.json({ models });
});

export default router;
