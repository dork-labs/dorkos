/**
 * Projects: the git main checkouts this machine knows (spec
 * `flow-multiproject` §6.1).
 *
 * - `GET /api/projects` lists every known project whose folder exists. It
 *   answers the person, so it is not scoped the way `ctx.projects.list()` is
 *   for an extension.
 * - `GET /api/projects/resolve?cwd=` names the project a folder belongs to.
 *   The folder AND the root git answers with must pass the directory boundary
 *   (`403` otherwise), so a worktree or a `.git` file pointing outside cannot
 *   reveal a folder the boundary keeps out. A lookup never marks a project as
 *   seen: only a real session, agent, workspace or install folder does, so a
 *   folder looked up here stays out of `GET /api/projects` until then.
 *
 *   A lookup records the root (as `reported`), so the name it answers stays
 *   that root's name; that is why it runs the person bar
 *   (`refuseIfNotAPerson`) even though it is a GET. The app asks it for the
 *   folder a person picked; an agent has no reason to, and an agent that could
 *   would hold names forever. The bar's documented residual applies: with
 *   login off, a local caller without `X-DorkOS-Agent` passes. The registry's
 *   cap on lookup-only roots (`MAX_LOOKUP_ROOTS`, least recently used
 *   forgotten) bounds what such a caller can record.
 *
 * @module routes/projects
 */
import { Router } from 'express';
import { z } from 'zod';
import { ProjectResolveQuerySchema } from '@dorkos/shared/project-schemas';

import { BoundaryError, validateBoundary } from '../lib/boundary.js';
import { logger } from '../lib/logger.js';
import { projectRegistry } from '../services/projects/project-registry.js';
import { refuseIfNotAPerson, type PersonBarCopy } from './extensions-person-bar.js';

/** What `GET /api/projects/resolve` says when the caller is not a person. */
const PROJECT_LOOKUP_BAR: PersonBarCopy = {
  error: 'Only a person can look up a project.',
  code: 'project_lookup_person_required',
  subject: 'the projects DorkOS remembers',
  crossSite: (origin) =>
    `DorkOS looked nothing up. This request came from ${origin}, which is not DorkOS. ` +
    `Only a person using DorkOS can look up a project.`,
  agent: 'DorkOS looked nothing up. Only a person can look up a project by folder.',
};

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
  if (refuseIfNotAPerson(req, res, PROJECT_LOOKUP_BAR)) return undefined;
  const parsed = ProjectResolveQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: z.treeifyError(parsed.error) });
  }
  try {
    const cwd = await validateBoundary(parsed.data.cwd);
    const project = await projectRegistry.resolveWithin(cwd);
    if (project === 'outside') {
      return res.status(403).json({
        error: 'Access denied: that folder belongs to a repository outside the directory boundary',
        code: 'OUTSIDE_BOUNDARY',
      });
    }
    return res.json({ project });
  } catch (err) {
    if (err instanceof BoundaryError) {
      return res.status(403).json({ error: err.message, code: err.code });
    }
    logger.error('[projects] GET /resolve failed', { err });
    return res.status(500).json({ error: 'Could not resolve the project' });
  }
});

export default router;
