import { Router } from 'express';
import { fileLister } from '../services/core/file-lister.js';
import { FileListQuerySchema } from '@dorkos/shared/schemas';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';
import { logger } from '../lib/logger.js';

const router = Router();

router.get('/', async (req, res) => {
  const parsed = FileListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: parsed.error.format() });
  }
  try {
    const validatedCwd = await validateBoundary(parsed.data.cwd);
    const result = await fileLister.listFiles(validatedCwd);
    res.json(result);
  } catch (err) {
    if (err instanceof BoundaryError) {
      return res.status(403).json({ error: err.message, code: err.code });
    }
    logger.error('[files] GET / failed', { err, cwd: parsed.data.cwd });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
