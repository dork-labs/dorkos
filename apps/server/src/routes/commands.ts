import { Router } from 'express';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { CommandsQuerySchema } from '@dorkos/shared/schemas';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';
import { logger } from '../lib/logger.js';

const router = Router();

/**
 * GET /api/commands — list slash commands for the resolved runtime.
 *
 * Accepts an optional `sessionId` query parameter. When provided, the route
 * resolves the runtime owning that session (per `session_metadata`). When
 * absent, falls back to the default runtime — this is a legitimate
 * cold-discovery path for screens without session context (onboarding,
 * first-run, command palette before any session is active).
 */
router.get('/', async (req, res) => {
  const parsed = CommandsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: parsed.error.format() });
  }
  const refresh = parsed.data.refresh === 'true';
  const sessionId = parsed.data.sessionId;
  try {
    let validatedCwd: string | undefined;
    if (parsed.data.cwd) {
      validatedCwd = await validateBoundary(parsed.data.cwd);
    }
    const runtime = sessionId
      ? await runtimeRegistry.resolveForSession(sessionId)
      : // cold discovery: no session context (onboarding, first-run)
        runtimeRegistry.getDefault();
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
