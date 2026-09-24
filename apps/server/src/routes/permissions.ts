/**
 * The permission routes (spec `agent-permissions` D10): read the default layer
 * and one agent's settings, change the preset, the defaults and one agent, and
 * read the history.
 *
 * ## Every mutating route proves a person
 *
 * The same two bars the approval decide route clears, reused rather than
 * restated, so "who counts as a person" cannot mean one thing here and another
 * there:
 *
 * 1. `resolveDecisionAuthority(readCallerAuthority(req, res))` refuses any caller
 *    presenting `X-DorkOS-Agent` (resolved or not) and any caller holding an
 *    approval token.
 * 2. `requireOperatorCookieUnderLogin` — with login on, only a browser session
 *    counts, never a per-user API key (DOR-474).
 *
 * With login off the write is recorded as `local-trust` and labelled "Someone on
 * this computer", because DorkOS cannot tell the person at the keyboard from any
 * other program running as the same user. That is the same residual every
 * login-off operator route carries; turning login on closes it.
 *
 * @module routes/permissions
 */
import { Router, type Request, type Response } from 'express';
import {
  PatchAgentPermissionsBodySchema,
  PatchPermissionDefaultsBodySchema,
  PermissionHistoryQuerySchema,
  SetPermissionPresetBodySchema,
} from '@dorkos/shared/permissions';

import { parseBody } from '../lib/route-utils.js';
import { readCallerAuthority, requireOperatorCookieUnderLogin } from '../lib/caller-authority.js';
import {
  resolveDecisionAuthority,
  type LoginEnabledLookup,
} from '../services/core/approvals/index.js';
import { readOwnerAccount } from '../services/core/auth/index.js';
import type { RequestUser } from '../services/core/auth/session-gate.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import {
  PermissionError,
  listPermissionHistory,
  personWriter,
  type PermissionService,
  type PermissionWriter,
} from '../services/core/permissions/index.js';

/** The sentence every refused non-person caller reads. */
const ONLY_A_PERSON = 'Only a person can change permissions. Agents can ask the person.';

/**
 * Clear both person bars, or answer the refusal.
 *
 * @returns The writer to record, or `undefined` when a refusal was sent.
 */
function requirePerson(
  req: Request,
  res: Response,
  isLoginEnabled?: LoginEnabledLookup
): PermissionWriter | undefined {
  const authority = resolveDecisionAuthority({
    ...readCallerAuthority(req, res),
    ...(isLoginEnabled ? { loginEnabled: isLoginEnabled } : {}),
  });
  if (!authority.allowed) {
    res.status(authority.status).json({ error: ONLY_A_PERSON, code: authority.code });
    return undefined;
  }
  const cookie = requireOperatorCookieUnderLogin(res, 'permissions', isLoginEnabled);
  if (cookie) {
    res.status(cookie.status).json({ error: ONLY_A_PERSON, code: cookie.code });
    return undefined;
  }
  return writerForPosture(authority.posture, res);
}

/**
 * The permission writer for a caller that cleared the person bars: "Someone on
 * this computer" with login off, the signed-in account with it on. Shared with
 * the approval grant route, whose Always allow writes a permission too, so both
 * doors record a person the same way.
 *
 * @param posture - The posture the person bars reported.
 * @param res - The response carrying `sessionGate`'s resolved user.
 */
export function writerForPosture(
  posture: 'local-trust' | 'signed-in-operator',
  res: Response
): PermissionWriter {
  if (posture === 'local-trust') return personWriter('local-trust');
  const user = res.locals.user as RequestUser | undefined;
  const owner = readOwnerAccount();
  const name = owner && user && owner.id === user.userId ? owner.name : (user?.userId ?? 'you');
  return personWriter('signed-in-operator', { id: user?.userId ?? 'unknown', name });
}

/** Answer a service refusal, or rethrow anything else. */
function sendPermissionError(res: Response, err: unknown): Response {
  if (err instanceof PermissionError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  throw err;
}

/**
 * Create the permissions router, mounted at `/api`.
 *
 * @param deps - The permission service, the Activity reader, and (in tests) a
 *   login-state lookup.
 * @returns An Express router serving `/permissions*` and `/agents/:id/permissions`.
 */
export function createPermissionsRouter(deps: {
  permissions: PermissionService;
  activity: Pick<ActivityService, 'list'>;
  isLoginEnabled?: LoginEnabledLookup;
}): Router {
  const router = Router();
  const { permissions, activity, isLoginEnabled } = deps;
  const person = (req: Request, res: Response) => requirePerson(req, res, isLoginEnabled);

  router.get('/permissions', async (_req, res) => {
    return res.json(await permissions.getOverview());
  });

  router.get('/permissions/history', async (req, res) => {
    const query = parseBody(PermissionHistoryQuerySchema, req.query, res);
    if (!query) return;
    return res.json(
      await listPermissionHistory(activity, {
        limit: query.limit,
        ...(query.agentId ? { agentId: query.agentId } : {}),
        ...(query.before ? { before: query.before } : {}),
      })
    );
  });

  router.put('/permissions/preset', async (req, res) => {
    const writer = person(req, res);
    if (!writer) return;
    const body = parseBody(SetPermissionPresetBodySchema, req.body, res);
    if (!body) return;
    try {
      const changes = await permissions.setPreset(body, writer);
      return res.json({ changes, permissions: await permissions.getOverview() });
    } catch (err) {
      return sendPermissionError(res, err);
    }
  });

  router.patch('/permissions/defaults', async (req, res) => {
    const writer = person(req, res);
    if (!writer) return;
    const body = parseBody(PatchPermissionDefaultsBodySchema, req.body, res);
    if (!body) return;
    try {
      const changes = await permissions.setDefaults(body, writer);
      return res.json({ changes, permissions: await permissions.getOverview() });
    } catch (err) {
      return sendPermissionError(res, err);
    }
  });

  router.get('/agents/:id/permissions', async (req, res) => {
    try {
      return res.json(await permissions.getAgent(req.params.id));
    } catch (err) {
      return sendPermissionError(res, err);
    }
  });

  router.patch('/agents/:id/permissions', async (req, res) => {
    const writer = person(req, res);
    if (!writer) return;
    const body = parseBody(PatchAgentPermissionsBodySchema, req.body, res);
    if (!body) return;
    try {
      const changes = await permissions.setAgent(req.params.id, body, writer);
      return res.json({ changes, permissions: await permissions.getAgent(req.params.id) });
    } catch (err) {
      return sendPermissionError(res, err);
    }
  });

  return router;
}
