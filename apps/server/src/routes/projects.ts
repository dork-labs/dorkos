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
 *   (`assessPerson`) even though it is a GET. The app asks it for the
 *   folder a person picked; an agent has no reason to, and an agent that could
 *   would hold names forever. The bar's `Origin` check alone does not cover a
 *   GET: a cross-site page can fire one with no `Origin` at all (an `<img>`
 *   or a no-cors `fetch`), so the route also refuses `Sec-Fetch-Site:
 *   cross-site`, which browsers send on exactly those requests. The bar's
 *   documented residual applies: with login off, a local caller without
 *   `X-DorkOS-Agent` (and not a browser) passes. The registry's cap on
 *   lookup-only roots (`MAX_LOOKUP_ROOTS`, least recently used forgotten)
 *   bounds what such a caller can record.
 *
 * @module routes/projects
 */
import { Hono } from 'hono';
import { ProjectResolveQuerySchema } from '@dorkos/shared/project-schemas';
import { BoundaryError, validateBoundary } from '../lib/boundary.js';
import { boundaryProblem } from '../http/problems/boundary-refusal.js';
import { logger } from '../lib/logger.js';
import { projectRegistry } from '../services/projects/project-registry.js';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import { assessPerson, type PersonBarCopy } from './extensions-person-bar.js';
import { problem, sendProblem, validationProblem } from '@dorkos/http-kit';

/** What `GET /api/projects/resolve` says when the caller is not a person. */
const PROJECT_LOOKUP_BAR: PersonBarCopy = {
  code: 'person_only',
  subject: 'the projects DorkOS remembers',
  crossSite: (origin) =>
    `DorkOS looked nothing up. This request came from ${origin}, which is not DorkOS. ` +
    `Only a person using DorkOS can look up a project.`,
  agent: 'DorkOS looked nothing up. Only a person can look up a project by folder.',
};

const router = new Hono<ApiEnv>();

router.get('/', async (c) => {
  try {
    return c.json({ projects: await projectRegistry.list() });
  } catch (err) {
    logger.error('[projects] GET / failed', { err });
    return problem(c, 'internal_error', { detail: 'Couldn’t list projects. Try again.' });
  }
});

router.get('/resolve', async (c) => {
  const facts = honoRequestFacts(c);
  if (facts.headers['sec-fetch-site'] === 'cross-site') {
    const from = facts.headers.origin ?? facts.headers.referer ?? 'another site';
    return problem(c, PROJECT_LOOKUP_BAR.code, { detail: PROJECT_LOOKUP_BAR.crossSite(from) });
  }
  const refusal = assessPerson(facts, PROJECT_LOOKUP_BAR);
  if (refusal) return sendProblem(c, refusal.body);
  const parsed = ProjectResolveQuerySchema.safeParse(readQuery(c));
  if (!parsed.success) {
    return validationProblem(c, parsed.error);
  }
  try {
    const cwd = await validateBoundary(parsed.data.cwd);
    const project = await projectRegistry.resolveWithin(cwd);
    if (project === 'outside') {
      return problem(c, 'outside_boundary', {
        detail: 'That folder’s repository is outside the folders DorkOS may use.',
      });
    }
    return c.json({ project });
  } catch (err) {
    if (err instanceof BoundaryError) return boundaryProblem(c, err);
    logger.error('[projects] GET /resolve failed', { err });
    return problem(c, 'internal_error', {
      detail: 'Couldn’t find that folder’s project. Try again.',
    });
  }
});

export default router;
