/**
 * Workspace HTTP API (DOR-84) — thin handlers over the WorkspaceManager.
 *
 * @module server/routes/workspaces
 */
import { Hono, type Context } from 'hono';
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
import { problem, readJsonBody, validationProblem } from '@dorkos/http-kit';
import { boundaryProblem } from '../http/problems/boundary-refusal.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import { runFrontDoorWrite } from './front-door-step-up.js';

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
    return validationProblem(c, parsed.error);
  }
  try {
    const workspaces = await getWorkspaceManager().list({ projectKey: parsed.data.projectKey });
    return c.json({ workspaces });
  } catch (err) {
    logger.error('[workspaces] GET / failed', { err });
    return problem(c, 'internal_error');
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
    return problem(c, 'internal_error');
  }
});

/** Resolve an absolute path (e.g. a session cwd) to its containing workspace. */
router.get('/resolve', async (c) => {
  const parsed = ResolveQuerySchema.safeParse(readQuery(c));
  if (!parsed.success) {
    return validationProblem(c, parsed.error);
  }
  try {
    const workspace = await getWorkspaceManager().resolveByPath(parsed.data.path);
    return c.json({ workspace });
  } catch (err) {
    logger.error('[workspaces] GET /resolve failed', { err });
    return problem(c, 'internal_error');
  }
});

/**
 * Return the allocated port block for the managed workspace containing `path`;
 * 404 when the path is not inside a managed workspace.
 */
router.post('/ports', async (c) => {
  const parsed = PortsBodySchema.safeParse(readJsonBody(c));
  if (!parsed.success) {
    return validationProblem(c, parsed.error);
  }
  try {
    const workspace = await getWorkspaceManager().resolveByPath(parsed.data.path);
    if (!workspace) {
      return problem(c, 'not_found', { detail: 'That path isn’t inside a managed workspace.' });
    }
    return c.json(derivePorts(workspace.portBase));
  } catch (err) {
    logger.error('[workspaces] POST /ports failed', { err });
    return problem(c, 'internal_error');
  }
});

/**
 * Provision-or-reuse a workspace. A new one is shown before anything runs
 * there (DOR-2335): a person sees what it brings (409 `needs_review`)
 * and sends back `approvedReviewHash`; an agent gets an approval card (202
 * `requires_confirmation`) and retries with `confirmationToken`. The person's
 * request with the hash waits for the owner's password (428, DOR-4355).
 */
router.post('/', async (c) => {
  const parsed = EnsureWorkspaceRequestSchema.safeParse(readJsonBody(c));
  const decision = WorkspaceDecisionSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
  if (!parsed.success) {
    return validationProblem(c, parsed.error);
  }
  if (!decision.success) {
    return validationProblem(c, decision.error);
  }
  const person = trustedCaller(readCallerAuthority(honoRequestFacts(c))) !== undefined;
  const name = `${parsed.data.projectKey}/${parsed.data.key}`;
  const ensure = async (): Promise<Response> => {
    try {
      const identity = c.get('agentIdentity');
      const gate = workspaceGateFor({
        trusted: person,
        name,
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
      return ensureFailed(c, err);
    }
  };
  // Without a review hash a person is shown what it brings first, and an agent
  // waits on its card: nothing runs there yet.
  if (!person || !decision.data.approvedReviewHash) return ensure();
  // The person's yes to the review runs the workspace's setup commands, so the
  // owner confirms it's them first (DOR-4355).
  return runFrontDoorWrite(c, {
    kind: 'workspace.setup',
    target: name,
    input: { ...parsed.data, approvedReviewHash: decision.data.approvedReviewHash },
    reason: `Set up the workspace ${name} and run its setup commands.`,
    subject: 'which setup commands run here',
    run: ensure,
  });
});

/** Answer a provision that did not make a workspace, with what the caller needs to go on. */
function ensureFailed(c: Context<ApiEnv>, err: unknown): Response {
  if (err instanceof UnsafeWorkspaceSourceError) {
    return problem(c, 'invalid_request', { detail: err.message });
  }
  if (err instanceof WorkspaceNeedsReviewError) {
    return problem(c, 'needs_review', {
      detail: err.message,
      extensions: { workspace: shownOf(err.inspection) },
    });
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
    return problem(c, 'declined', { detail: err.message });
  }
  logger.error('[workspaces] POST / failed', { err });
  return problem(c, 'internal_error');
}

/** Get one workspace by id. */
router.get('/:id', async (c) => {
  try {
    const workspace = await getWorkspaceManager().get(c.req.param('id'));
    if (!workspace) return problem(c, 'not_found', { detail: 'No workspace with that id.' });
    return c.json(workspace);
  } catch (err) {
    logger.error('[workspaces] GET /:id failed', { err });
    return problem(c, 'internal_error');
  }
});

/** Pin or unpin a workspace. */
router.post('/:id/pin', async (c) => {
  const parsed = PinBodySchema.safeParse(readJsonBody(c));
  if (!parsed.success) {
    return validationProblem(c, parsed.error);
  }
  try {
    const workspace = await getWorkspaceManager().setPinned(c.req.param('id'), parsed.data.pinned);
    return c.json(workspace);
  } catch (err) {
    logger.error('[workspaces] POST /:id/pin failed', { err });
    return problem(c, 'not_found', { detail: 'No workspace with that id.' });
  }
});

/**
 * Remove a workspace; refuses a dirty one unless `?force=true`.
 *
 * A workspace made before its removal commands were recorded (DOR-2335) runs
 * only commands a person saw. A person is shown its source's `before_remove`
 * commands (409 `needs_review`) and allows exactly those with
 * `?approvedRemoveHooks=<reviewHash>`, or removes it without them with
 * `?skipRemoveHooks=true`. Any other caller removes it without running them.
 * Whenever they are left out, the response lists them in `skippedHooks`. Only
 * the request that allows them waits for the owner's password (428, DOR-4355).
 */
router.delete('/:id', async (c) => {
  const parsed = RemoveQuerySchema.safeParse(readQuery(c));
  if (!parsed.success) {
    return validationProblem(c, parsed.error);
  }
  const id = c.req.param('id');
  const person = trustedCaller(readCallerAuthority(honoRequestFacts(c))) !== undefined;
  const approvedRemoveHooks = person ? parsed.data.approvedRemoveHooks : undefined;
  const remove = async (): Promise<Response> => {
    try {
      const result = await getWorkspaceManager().remove(id, {
        force: parsed.data.force ?? false,
        unreviewedHooks: person && !parsed.data.skipRemoveHooks ? 'ask' : 'skip',
        ...(approvedRemoveHooks && { approvedRemoveHooks }),
      });
      if (result.blocked === 'hooks') {
        // Made before DorkOS recorded removal commands, and its source declares some now.
        return problem(c, 'needs_review', {
          detail:
            'Look at its removal commands, then send approvedRemoveHooks with the review hash, ' +
            'or skipRemoveHooks=true.',
          extensions: { ...result.hooks },
        });
      }
      // 404 only when the workspace genuinely doesn't exist. A dirty refusal is a
      // valid outcome carried in the RemoveResult body (`removed:false, blocked:'dirty'`),
      // so the client can escalate to a force-confirm rather than seeing a generic error.
      if (!result.removed && !result.blocked)
        return problem(c, 'not_found', { detail: 'No workspace with that id.' });
      return c.json(result);
    } catch (err) {
      if (err instanceof BoundaryError) return boundaryProblem(c, err);
      logger.error('[workspaces] DELETE /:id failed', { err });
      return problem(c, 'internal_error');
    }
  };
  // Removing without the commands it was not made with stays immediate.
  if (!approvedRemoveHooks) return remove();
  let workspace: { projectKey: string; key: string } | null;
  try {
    workspace = await getWorkspaceManager().get(id);
  } catch (err) {
    logger.error('[workspaces] DELETE /:id failed', { err });
    return problem(c, 'internal_error');
  }
  if (!workspace) return problem(c, 'not_found', { detail: 'No workspace with that id.' });
  const name = `${workspace.projectKey}/${workspace.key}`;
  // A person's yes to the removal commands runs them, so the owner confirms
  // it's them first (DOR-4355).
  return runFrontDoorWrite(c, {
    kind: 'workspace.setup',
    target: name,
    input: { id, force: parsed.data.force ?? false, approvedRemoveHooks },
    reason: `Remove the workspace ${name} and run its removal commands.`,
    subject: 'which setup commands run here',
    run: remove,
  });
});

export default router;
