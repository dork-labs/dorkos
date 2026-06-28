import { Router } from 'express';
import { z } from 'zod';
import { getGitStatus } from '../services/core/git-status.js';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';
import { logger } from '../lib/logger.js';

const router = Router();

const GitStatusQuerySchema = z.object({
  dir: z.string().optional(),
});

router.get('/status', async (req, res) => {
  const parsed = GitStatusQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: z.treeifyError(parsed.error) });
  }
  try {
    let validatedDir: string | undefined;
    if (parsed.data.dir) {
      validatedDir = await validateBoundary(parsed.data.dir);
    }
    const cwd = validatedDir || process.cwd();
    const result = await getGitStatus(cwd);
    res.json(result);
  } catch (err) {
    if (err instanceof BoundaryError) {
      return res.status(403).json({ error: err.message, code: err.code });
    }
    logger.error('[git] GET /status failed', { err, dir: parsed.data.dir });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
