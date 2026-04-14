import { Router } from 'express';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { CommandsQuerySchema } from '@dorkos/shared/schemas';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';
import { logger } from '../lib/logger.js';

const router = Router();

// GET /api/commands - List all commands (with optional refresh and cwd)
router.get('/', async (req, res) => {
  const parsed = CommandsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: parsed.error.format() });
  }
  const refresh = parsed.data.refresh === 'true';
  try {
    let validatedCwd: string | undefined;
    if (parsed.data.cwd) {
      validatedCwd = await validateBoundary(parsed.data.cwd);
    }
    const runtime = runtimeRegistry.getDefault();
    const commands = await runtime.getCommands(refresh, validatedCwd);
    res.json(commands);
  } catch (err) {
    if (err instanceof BoundaryError) {
      return res.status(403).json({ error: err.message, code: err.code });
    }
    logger.error('[commands] GET / failed', { err, cwd: parsed.data.cwd });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
