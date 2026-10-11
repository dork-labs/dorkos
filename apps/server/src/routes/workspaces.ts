/**
 * Workspace HTTP API (DOR-84) — thin handlers over the WorkspaceManager.
 *
 * @module server/routes/workspaces
 */
import { Hono } from 'hono';
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
import { BoundaryError } from '../lib/boundary.js';
import { logger } from '../lib/logger.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';

const router = new Hono<ApiEnv>();

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
router.get('/', async (c) => {
  const parsed = ListQuerySchema.safeParse(readQuery(c));
  if (!parsed.success) {
    return c.json({ error: 'Invalid query', details: z.flattenError(parsed.error) }, 400);
  }
  try {
    const workspaces = await getWorkspaceManager().list({ projectKey: parsed.data.projectKey });
    return c.json({ workspaces });
  } catch (err) {
    logger.error('[workspaces] GET / failed', { err });
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * Read-only adoption scan (DOR-1056): every real checkout under the workspace
 * root, with the facts git can answer cheaply. Declared before `/:id` so the
 * literal path wins over the parameter.
 */
router.get('/scan', async (c) => {
  try {
    return c.json(await scanWorktrees(getWorkspaceRoot()));
  } catch (err) {
    logger.error('[workspaces] GET /scan failed', { err });
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/** Resolve an absolute path (e.g. a session cwd) to its containing workspace. */
router.get('/resolve', async (c) => {
  const parsed = ResolveQuerySchema.safeParse(readQuery(c));
  if (!parsed.success) {
    return c.json({ error: 'Invalid query', details: z.flattenError(parsed.error) }, 400);
  }
  try {
    const workspace = await getWorkspaceManager().resolveByPath(parsed.data.path);
    return c.json({ workspace });
  } catch (err) {
    logger.error('[workspaces] GET /resolve failed', { err });
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * Return the allocated port block for the managed workspace containing `path`;
 * 404 when the path is not inside a managed workspace.
 */
router.post('/ports', async (c) => {
  const parsed = PortsBodySchema.safeParse(readJsonBody(c));
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: z.flattenError(parsed.error) }, 400);
  }
  try {
    const workspace = await getWorkspaceManager().resolveByPath(parsed.data.path);
    if (!workspace) return c.json({ error: 'No managed workspace for path' }, 404);
    return c.json(derivePorts(workspace.portBase));
  } catch (err) {
    logger.error('[workspaces] POST /ports failed', { err });
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * Provision-or-reuse a workspace. A new one is shown before anything runs
 * there (DOR-2335): a person sees what it brings (409 `workspace_needs_review`)
 * and sends back `approvedReviewHash`; an agent gets an approval card (202
 * `requires_confirmation`) and retries with `confirmationToken`.
 */
router.post('/', async (c) => {
  const parsed = EnsureWorkspaceRequestSchema.safeParse(readJsonBody(c));
  const decision = WorkspaceDecisionSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: z.flattenError(parsed.error) }, 400);
  }
  if (!decision.success) {
    return c.json({ error: 'Validation failed', details: z.flattenError(decision.error) }, 400);
  }
  try {
    const identity = c.get('agentIdentity');
    const gate = workspaceGateFor({
      trusted: trustedCaller(readCallerAuthority(honoRequestFacts(c))) !== undefined,
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
    return c.json(workspace, 201);
  } catch (err) {
    if (err instanceof UnsafeWorkspaceSourceError) {
      return c.json({ error: err.message, code: 'UNSAFE_WORKSPACE_SOURCE' }, 400);
    }
    if (err instanceof WorkspaceNeedsReviewError) {
      return c.json(
        { error: err.message, code: err.code, workspace: shownOf(err.inspection) },
        409
      );
    }
    if (err instanceof WorkspaceApprovalPendingError) {
      return c.json(
        {
          status: err.status,
          confirmationToken: err.token,
          message: err.message,
          workspace: shownOf(err.inspection),
          ...(err.reason ? { reason: err.reason } : {}),
        },
        202
      );
    }
    if (err instanceof WorkspaceDeclinedError) {
      return c.json({ status: 'declined', error: err.message }, 403);
    }
    logger.error('[workspaces] POST / failed', { err });
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/** Get one workspace by id. */
router.get('/:id', async (c) => {
  try {
    const workspace = await getWorkspaceManager().get(c.req.param('id'));
    if (!workspace) return c.json({ error: 'Not found' }, 404);
    return c.json(workspace);
  } catch (err) {
    logger.error('[workspaces] GET /:id failed', { err });
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/** Pin or unpin a workspace. */
router.post('/:id/pin', async (c) => {
  const parsed = PinBodySchema.safeParse(readJsonBody(c));
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: z.flattenError(parsed.error) }, 400);
  }
  try {
    const workspace = await getWorkspaceManager().setPinned(c.req.param('id'), parsed.data.pinned);
    return c.json(workspace);
  } catch (err) {
    logger.error('[workspaces] POST /:id/pin failed', { err });
    return c.json({ error: 'Not found' }, 404);
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
router.delete('/:id', async (c) => {
  const parsed = RemoveQuerySchema.safeParse(readQuery(c));
  if (!parsed.success) {
    return c.json({ error: 'Invalid query', details: z.flattenError(parsed.error) }, 400);
  }
  try {
    const person = trustedCaller(readCallerAuthority(honoRequestFacts(c))) !== undefined;
    const result = await getWorkspaceManager().remove(c.req.param('id'), {
      force: parsed.data.force ?? false,
      unreviewedHooks: person && !parsed.data.skipRemoveHooks ? 'ask' : 'skip',
      ...(person &&
        parsed.data.approvedRemoveHooks && {
          approvedRemoveHooks: parsed.data.approvedRemoveHooks,
        }),
    });
    if (result.blocked === 'hooks') {
      return c.json(
        {
          code: 'remove_hooks_need_review',
          error:
            'This workspace was made before DorkOS recorded its removal commands, and its source ' +
            'now declares some. Look at them, then remove it again with approvedRemoveHooks set to ' +
            'the review hash to run exactly these, or with skipRemoveHooks=true to remove it without ' +
            'running them.',
          ...result.hooks,
        },
        409
      );
    }
    // 404 only when the workspace genuinely doesn't exist. A dirty refusal is a
    // valid outcome carried in the RemoveResult body (`removed:false, blocked:'dirty'`),
    // so the client can escalate to a force-confirm rather than seeing a generic error.
    if (!result.removed && !result.blocked) return c.json({ error: 'Not found' }, 404);
    return c.json(result);
  } catch (err) {
    if (err instanceof BoundaryError) {
      return c.json({ error: err.message, code: err.code }, 403);
    }
    logger.error('[workspaces] DELETE /:id failed', { err });
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default router;
