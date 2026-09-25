/**
 * Workspace HTTP API (DOR-84) — thin handlers over the WorkspaceManager.
 *
 * @module server/routes/workspaces
 */
import { Router } from 'express';
import { z } from 'zod';
import { EnsureWorkspaceRequestSchema, derivePorts } from '@dorkos/shared/workspace';
import {
  getWorkspaceManager,
  getWorkspaceRoot,
  scanWorktrees,
  UnsafeWorkspaceSourceError,
  workspaceGateFor,
  WorkspaceApprovalPendingError,
  WorkspaceDeclinedError,
  WorkspaceNeedsReviewError,
  type WorkspaceInspection,
} from '../services/workspace/index.js';
import { trustedCaller } from '../services/core/capabilities/index.js';
import { readCallerAuthority } from '../lib/caller-authority.js';
import { getRequestAgentIdentity } from '../middleware/agent-identity.js';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';
import { logger } from '../lib/logger.js';

const router = Router();

const ListQuerySchema = z.object({ projectKey: z.string().optional() });
const ResolveQuerySchema = z.object({ path: z.string().min(1) });
const PortsBodySchema = z.object({ path: z.string().min(1) });
const PinBodySchema = z.object({ pinned: z.boolean() });
const RemoveQuerySchema = z.object({
  force: z.coerce.boolean().optional(),
  approvedRemoveHooks: z.string().min(1).optional(),
  skipRemoveHooks: z.coerce.boolean().optional(),
});

/** What a caller sends back after a review or a card (DOR-2335). */
const WorkspaceDecisionSchema = z.object({
  approvedReviewHash: z.string().min(1).optional(),
  confirmationToken: z.string().min(1).optional(),
});

/**
 * What a new workspace brings, for the caller to show: every settings file
 * written out, every link, and the hooks DorkOS runs, with the hash that
 * binds them.
 */
function shownOf(inspection: WorkspaceInspection) {
  return {
    source: inspection.source,
    provider: inspection.provider,
    path: inspection.destination,
    reviewHash: inspection.reviewHash,
    contentHash: inspection.contentHash,
    findings: inspection.tree?.findings ?? [],
    settings: inspection.tree?.settings ?? [],
    disclosed: inspection.tree?.disclosed ?? null,
    links: inspection.links,
    hooks: inspection.hooks,
  };
}

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

/**
 * Read-only adoption scan (DOR-1056): every real checkout under the workspace
 * root, with the facts git can answer cheaply. Declared before `/:id` so the
 * literal path wins over the parameter.
 */
router.get('/scan', async (_req, res) => {
  try {
    res.json(await scanWorktrees(getWorkspaceRoot()));
  } catch (err) {
    logger.error('[workspaces] GET /scan failed', { err });
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
 * Return the allocated port block for the managed workspace containing `path`;
 * 404 when the path is not inside a managed workspace.
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

/**
 * Provision-or-reuse a workspace. A new one is shown before anything runs
 * there (DOR-2335): a person sees what it brings (409 `workspace_needs_review`)
 * and sends back `approvedReviewHash`; an agent gets an approval card (202
 * `requires_confirmation`) and retries with `confirmationToken`.
 */
router.post('/', async (req, res) => {
  const parsed = EnsureWorkspaceRequestSchema.safeParse(req.body);
  const decision = WorkspaceDecisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'Validation failed', details: z.flattenError(parsed.error) });
  }
  if (!decision.success) {
    return res
      .status(400)
      .json({ error: 'Validation failed', details: z.flattenError(decision.error) });
  }
  try {
    const identity = getRequestAgentIdentity(res);
    const gate = workspaceGateFor({
      trusted: trustedCaller(readCallerAuthority(req, res)) !== undefined,
      name: `${parsed.data.projectKey}/${parsed.data.key}`,
      carriesToken: true,
      ...(identity && { requestedBy: identity.displayName || identity.agentPath }),
      ...(decision.data.approvedReviewHash && {
        approvedReviewHash: decision.data.approvedReviewHash,
      }),
      ...(decision.data.confirmationToken && {
        confirmationToken: decision.data.confirmationToken,
      }),
    });
    const workspace = await getWorkspaceManager().ensure(parsed.data, gate);
    res.status(201).json(workspace);
  } catch (err) {
    if (err instanceof UnsafeWorkspaceSourceError) {
      return res.status(400).json({ error: err.message, code: 'UNSAFE_WORKSPACE_SOURCE' });
    }
    if (err instanceof WorkspaceNeedsReviewError) {
      return res
        .status(409)
        .json({ error: err.message, code: err.code, workspace: shownOf(err.inspection) });
    }
    if (err instanceof WorkspaceApprovalPendingError) {
      return res.status(202).json({
        status: err.status,
        confirmationToken: err.token,
        message: err.message,
        workspace: shownOf(err.inspection),
        ...(err.reason ? { reason: err.reason } : {}),
      });
    }
    if (err instanceof WorkspaceDeclinedError) {
      return res.status(403).json({ status: 'declined', error: err.message });
    }
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

/**
 * Remove a workspace; refuses a dirty one unless `?force=true`.
 *
 * A workspace made before its removal commands were recorded (DOR-2335) runs
 * only commands a person saw. A person is shown its source's `before_remove`
 * commands (409 `remove_hooks_need_review`) and allows exactly those with
 * `?approvedRemoveHooks=<reviewHash>`, or removes it without them with
 * `?skipRemoveHooks=true`. Any other caller removes it without running them.
 * Whenever they are left out, the response lists them in `skippedHooks`.
 */
router.delete('/:id', async (req, res) => {
  const parsed = RemoveQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: z.flattenError(parsed.error) });
  }
  try {
    const person = trustedCaller(readCallerAuthority(req, res)) !== undefined;
    const result = await getWorkspaceManager().remove(req.params.id, {
      force: parsed.data.force ?? false,
      unreviewedHooks: person && !parsed.data.skipRemoveHooks ? 'ask' : 'skip',
      ...(person &&
        parsed.data.approvedRemoveHooks && {
          approvedRemoveHooks: parsed.data.approvedRemoveHooks,
        }),
    });
    if (result.blocked === 'hooks') {
      return res.status(409).json({
        code: 'remove_hooks_need_review',
        error:
          'This workspace was made before DorkOS recorded its removal commands, and its source ' +
          'now declares some. Look at them, then remove it again with approvedRemoveHooks set to ' +
          'the review hash to run exactly these, or with skipRemoveHooks=true to remove it without ' +
          'running them.',
        ...result.hooks,
      });
    }
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
