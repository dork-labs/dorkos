import { Router } from 'express';
import { z } from 'zod';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { CommandsQuerySchema } from '@dorkos/shared/schemas';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';
import { logger } from '../lib/logger.js';

const router = Router();

/**
 * GET /api/commands — list slash commands for the resolved runtime.
 *
 * Resolution priority (mirrors `GET /api/models`):
 * 1. An explicit `runtime` query param — validated against the registry (400 on
 *    unknown). This is the not-yet-started-session path: a brand-new session has
 *    no `session_metadata` row, so resolving by `sessionId` alone would infer
 *    the default (`claude-code`) and wrongly show Claude's commands for a Codex
 *    session before its first message.
 * 2. Else a `sessionId` — resolves the runtime owning that session.
 * 3. Else the default runtime — the legitimate cold-discovery path for screens
 *    without session context (onboarding, first-run, command palette before any
 *    session is active).
 */
router.get('/', async (req, res) => {
  const parsed = CommandsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: z.treeifyError(parsed.error) });
  }
  const refresh = parsed.data.refresh === 'true';
  const runtimeParam = parsed.data.runtime;
  const sessionId = parsed.data.sessionId;
  try {
    let validatedCwd: string | undefined;
    if (parsed.data.cwd) {
      validatedCwd = await validateBoundary(parsed.data.cwd);
    }
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
    const commands = await runtime.getCommands(refresh, validatedCwd);
    res.json(commands);
  } catch (err) {
    if (err instanceof BoundaryError) {
      return res.status(403).json({ error: err.message, code: err.code });
    }
    logger.error('[commands] GET / failed', { err, cwd: parsed.data.cwd, sessionId });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
