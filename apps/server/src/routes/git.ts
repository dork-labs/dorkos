import { Router } from 'express';
import { z } from 'zod';
import { getGitStatus } from '../services/core/git-status.js';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';

const router = Router();

const GitStatusQuerySchema = z.object({
  dir: z.string().optional(),
});

router.get('/status', async (req, res) => {
  const parsed = GitStatusQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: parsed.error.format() });
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
    throw err;
  }
});

export default router;
