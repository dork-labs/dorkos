/**
 * Projects: the git main checkouts this machine knows (spec
 * `flow-multiproject` §6.1).
 *
 * - `GET /api/projects` lists every known project whose folder exists. It
 *   answers the person, so it is not scoped the way `ctx.projects.list()` is
 *   for an extension.
 * - `GET /api/projects/resolve?cwd=` names the project a folder belongs to.
 *   The folder must pass the directory boundary (`403` otherwise), so the
 *   route cannot be used to probe folders outside it.
 *
 * @module routes/projects
 */
import { Router } from 'express';
import { z } from 'zod';
import { ProjectResolveQuerySchema } from '@dorkos/shared/project-schemas';

import { BoundaryError, validateBoundary } from '../lib/boundary.js';
import { logger } from '../lib/logger.js';
import { projectRegistry } from '../services/projects/project-registry.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    res.json({ projects: await projectRegistry.list() });
  } catch (err) {
    logger.error('[projects] GET / failed', { err });
    res.status(500).json({ error: 'Could not list projects' });
  }
});

router.get('/resolve', async (req, res) => {
  const parsed = ProjectResolveQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: z.treeifyError(parsed.error) });
  }
  try {
    const cwd = await validateBoundary(parsed.data.cwd);
    return res.json({ project: await projectRegistry.resolve(cwd) });
  } catch (err) {
    if (err instanceof BoundaryError) {
      return res.status(403).json({ error: err.message, code: err.code });
    }
    logger.error('[projects] GET /resolve failed', { err });
    return res.status(500).json({ error: 'Could not resolve the project' });
  }
});

export default router;
