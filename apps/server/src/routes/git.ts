import { Hono } from 'hono';
import { z } from 'zod';
import { getGitStatus } from '../services/core/git-status.js';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';
import { DEFAULT_CWD } from '../lib/resolve-root.js';
import { logger } from '../lib/logger.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readQuery } from '../http/request-query.js';

const router = new Hono<ApiEnv>();

const GitStatusQuerySchema = z.object({
  dir: z.string().optional(),
});

router.get('/status', async (c) => {
  const parsed = GitStatusQuerySchema.safeParse(readQuery(c));
  if (!parsed.success) {
    return c.json({ error: 'Invalid query', details: z.treeifyError(parsed.error) }, 400);
  }
  try {
    let validatedDir: string | undefined;
    if (parsed.data.dir) {
      validatedDir = await validateBoundary(parsed.data.dir);
    }
    const cwd = validatedDir || DEFAULT_CWD;
    const result = await getGitStatus(cwd);
    return c.json(result);
  } catch (err) {
    if (err instanceof BoundaryError) {
      return c.json({ error: err.message, code: err.code }, 403);
    }
    logger.error('[git] GET /status failed', { err, dir: parsed.data.dir });
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default router;
