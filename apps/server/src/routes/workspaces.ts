/**
 * Workspace HTTP API (DOR-84) — thin handlers over the WorkspaceManager.
 *
 * @module server/routes/workspaces
 */
import { Router } from 'express';
import { z } from 'zod';
import { EnsureWorkspaceRequestSchema, derivePorts } from '@dorkos/shared/workspace';
import { getWorkspaceManager } from '../services/workspace/index.js';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';
import { logger } from '../lib/logger.js';

const router = Router();

const ListQuerySchema = z.object({ projectKey: z.string().optional() });
const ResolveQuerySchema = z.object({ path: z.string().min(1) });
const PortsBodySchema = z.object({ path: z.string().min(1) });
const PinBodySchema = z.object({ pinned: z.boolean() });
const RemoveQuerySchema = z.object({ force: z.coerce.boolean().optional() });

/** List workspaces (optionally one project), each with attached sessions. */
router.get('/', async (req, res) => {
  const parsed = ListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: z.flattenError(parsed.error) });
  }
  try {
    const workspaces = await getWorkspaceManager().list({ projectKey: parsed.data.projectKey });
    res.json({ workspaces });
  } catch (err) {
    logger.error('[workspaces] GET / failed', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** Resolve an absolute path (e.g. a session cwd) to its containing workspace. */
router.get('/resolve', async (req, res) => {
  const parsed = ResolveQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: z.flattenError(parsed.error) });
  }
  try {
    const workspace = await getWorkspaceManager().resolveByPath(parsed.data.path);
    res.json({ workspace });
  } catch (err) {
    logger.error('[workspaces] GET /resolve failed', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Return the allocated port block for the managed workspace containing `path`.
 * `worktree-setup.sh` calls this; a 404 tells it to fall back to hash derivation.
 */
router.post('/ports', async (req, res) => {
  const parsed = PortsBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'Validation failed', details: z.flattenError(parsed.error) });
  }
  try {
    const workspace = await getWorkspaceManager().resolveByPath(parsed.data.path);
    if (!workspace) return res.status(404).json({ error: 'No managed workspace for path' });
    res.json(derivePorts(workspace.portBase));
  } catch (err) {
    logger.error('[workspaces] POST /ports failed', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** Provision-or-reuse a workspace. */
router.post('/', async (req, res) => {
  const parsed = EnsureWorkspaceRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'Validation failed', details: z.flattenError(parsed.error) });
  }
  try {
    const workspace = await getWorkspaceManager().ensure(parsed.data);
    res.status(201).json(workspace);
  } catch (err) {
    logger.error('[workspaces] POST / failed', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** Get one workspace by id. */
router.get('/:id', async (req, res) => {
  try {
    const workspace = await getWorkspaceManager().get(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Not found' });
    res.json(workspace);
  } catch (err) {
    logger.error('[workspaces] GET /:id failed', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** Pin or unpin a workspace. */
router.post('/:id/pin', async (req, res) => {
  const parsed = PinBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'Validation failed', details: z.flattenError(parsed.error) });
  }
  try {
    const workspace = await getWorkspaceManager().setPinned(req.params.id, parsed.data.pinned);
    res.json(workspace);
  } catch (err) {
    logger.error('[workspaces] POST /:id/pin failed', { err });
    res.status(404).json({ error: 'Not found' });
  }
});

/** Remove a workspace; refuses a dirty one unless `?force=true`. */
router.delete('/:id', async (req, res) => {
  const parsed = RemoveQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: z.flattenError(parsed.error) });
  }
  try {
    const result = await getWorkspaceManager().remove(req.params.id, {
      force: parsed.data.force ?? false,
    });
    // 404 only when the workspace genuinely doesn't exist. A dirty refusal is a
    // valid outcome carried in the RemoveResult body (`removed:false, blocked:'dirty'`),
    // so the client can escalate to a force-confirm rather than seeing a generic error.
    if (!result.removed && !result.blocked) return res.status(404).json({ error: 'Not found' });
    res.json(result);
  } catch (err) {
    if (err instanceof BoundaryError) {
      return res.status(403).json({ error: err.message, code: err.code });
    }
    logger.error('[workspaces] DELETE /:id failed', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
