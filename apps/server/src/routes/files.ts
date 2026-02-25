import { Router } from 'express';
import { fileLister } from '../services/core/file-lister.js';
import { FileListQuerySchema } from '@dorkos/shared/schemas';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';

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
    throw err;
  }
});

export default router;
