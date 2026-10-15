/**
 * The permission routes (spec `agent-permissions` D10): read the default layer
 * and one agent's settings, change the preset, the defaults and one agent, read
 * the history, and undo one change from it (D14).
 *
 * ## Every mutating route proves a person
 *
 * The same two bars the approval decide route clears, reused rather than
 * restated, so "who counts as a person" cannot mean one thing here and another
 * there:
 *
 * 1. `resolveDecisionAuthority(readCallerAuthority(facts))` refuses any caller
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
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  PatchAgentPermissionsBodySchema,
  PatchPermissionDefaultsBodySchema,
  PermissionHistoryQuerySchema,
  SetPermissionPresetBodySchema,
  UndoPermissionChangeBodySchema,
} from '@dorkos/shared/permissions';

import { validationFailureBody } from '../lib/route-utils.js';
import { readCallerAuthority, requireOperatorCookieUnderLogin } from '../lib/caller-authority.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import {
  resolveDecisionAuthority,
  type LoginEnabledLookup,
} from '../services/core/approvals/index.js';
import { getUserById, readOwnerAccount } from '../services/core/auth/index.js';
import { configManager } from '../services/core/config-manager.js';
import { resolveAnswererName } from '../services/identity/operator-profile.js';
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
 * Clear both person bars.
 *
 * @returns The writer to record, or the refusal to answer with.
 */
function requirePerson(
  c: Context<ApiEnv>,
  isLoginEnabled?: LoginEnabledLookup
): { writer: PermissionWriter } | { refusal: Response } {
  const facts = honoRequestFacts(c);
  const authority = resolveDecisionAuthority({
    ...readCallerAuthority(facts),
    ...(isLoginEnabled ? { loginEnabled: isLoginEnabled } : {}),
  });
  if (!authority.allowed) {
    return {
      refusal: c.json(
        { error: ONLY_A_PERSON, code: authority.code },
        authority.status as ContentfulStatusCode
      ),
    };
  }
  const cookie = requireOperatorCookieUnderLogin(facts, 'permissions', isLoginEnabled);
  if (cookie) {
    return {
      refusal: c.json(
        { error: ONLY_A_PERSON, code: cookie.code },
        cookie.status as ContentfulStatusCode
      ),
    };
  }
  return { writer: writerForPosture(authority.posture, facts.user) };
}

/**
 * The permission writer for a caller that cleared the person bars: "Someone on
 * this computer" with login off, the signed-in account with it on. Shared with
 * the approval grant route, whose Always allow writes a permission too, so both
 * doors record a person the same way.
 *
 * @param posture - The posture the person bars reported.
 * @param user - The user the session gate resolved, if any.
 */
export function writerForPosture(
  posture: 'local-trust' | 'signed-in-operator',
  user: RequestUser | undefined
): PermissionWriter {
  if (posture === 'local-trust') return personWriter('local-trust');
  const owner = readOwnerAccount();
  const name =
    owner && user && owner.id === user.userId ? ownerLabel(owner.id) : (user?.userId ?? 'you');
  return personWriter('signed-in-operator', { id: user?.userId ?? 'unknown', name });
}

/**
 * What a permission's history calls the signed-in owner: the same name ladder
 * the roster uses, then their email. An account made since DOR-2964 has an empty
 * name, and an older one may carry its email as the name, so the raw column
 * would print "You (signed in as )" or a name that is only an address.
 *
 * @param ownerId - The owner account's id.
 */
function ownerLabel(ownerId: string): string {
  const account = getUserById(ownerId);
  return (
    resolveAnswererName({
      account: () => account,
      configDisplayName: () => configManager.get('profile')?.displayName ?? null,
    }) ??
    account?.email ??
    'you'
  );
}

/** Answer a service refusal, or rethrow anything else. */
function sendPermissionError(c: Context<ApiEnv>, err: unknown): Response {
  if (err instanceof PermissionError) {
    return c.json(
      { error: err.message, code: err.code, ...err.details },
      err.status as ContentfulStatusCode
    );
  }
  throw err;
}

/** What the permission routes read. */
export interface PermissionsRouterDeps {
  /** The one owner of every permission write. */
  permissions: PermissionService;
  /** The Activity reader the history comes from. */
  activity: Pick<ActivityService, 'list'>;
  /** In tests, a login-state lookup; the live config otherwise. */
  isLoginEnabled?: LoginEnabledLookup;
}

/**
 * The permission routes, to mount at `/api`. Only these concrete paths are
 * registered, so the group answers nothing else under `/api`.
 *
 * @param deps - See {@link PermissionsRouterDeps}.
 * @returns The routes serving `/permissions*` and `/agents/:id/permissions`.
 */
export function createPermissionsRoutes(deps: PermissionsRouterDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  const { permissions, activity, isLoginEnabled } = deps;
  const person = (c: Context<ApiEnv>) => requirePerson(c, isLoginEnabled);

  router.get('/permissions', async (c) => {
    return c.json(await permissions.getOverview());
  });

  router.get('/permissions/history', async (c) => {
    const query = PermissionHistoryQuerySchema.safeParse(readQuery(c));
    if (!query.success) return c.json(validationFailureBody(query.error), 400);
    return c.json(
      await listPermissionHistory(activity, {
        limit: query.data.limit,
        ...(query.data.agentId ? { agentId: query.data.agentId } : {}),
        ...(query.data.before ? { before: query.data.before } : {}),
      })
    );
  });

  router.put('/permissions/preset', async (c) => {
    const caller = person(c);
    if ('refusal' in caller) return caller.refusal;
    const body = SetPermissionPresetBodySchema.safeParse(readJsonBody(c));
    if (!body.success) return c.json(validationFailureBody(body.error), 400);
    try {
      const changes = await permissions.setPreset(body.data, caller.writer);
      return c.json({ changes, permissions: await permissions.getOverview() });
    } catch (err) {
      return sendPermissionError(c, err);
    }
  });

  router.patch('/permissions/defaults', async (c) => {
    const caller = person(c);
    if ('refusal' in caller) return caller.refusal;
    const body = PatchPermissionDefaultsBodySchema.safeParse(readJsonBody(c));
    if (!body.success) return c.json(validationFailureBody(body.error), 400);
    try {
      const changes = await permissions.setDefaults(body.data, caller.writer);
      return c.json({ changes, permissions: await permissions.getOverview() });
    } catch (err) {
      return sendPermissionError(c, err);
    }
  });

  // Undo one recorded change: a new change, audited like any other. A key
  // that changed since is a conflict the person decides on (409, then `force`).
  router.post('/permissions/history/:eventId/undo', async (c) => {
    const caller = person(c);
    if ('refusal' in caller) return caller.refusal;
    // An empty POST reads as `{}`, as Express 5's undefined `req.body` did: a plain Undo.
    const body = UndoPermissionChangeBodySchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!body.success) return c.json(validationFailureBody(body.error), 400);
    try {
      return c.json(await permissions.undo(c.req.param('eventId'), body.data, caller.writer));
    } catch (err) {
      return sendPermissionError(c, err);
    }
  });

  router.get('/agents/:id/permissions', async (c) => {
    try {
      return c.json(await permissions.getAgent(c.req.param('id')));
    } catch (err) {
      return sendPermissionError(c, err);
    }
  });

  router.patch('/agents/:id/permissions', async (c) => {
    const caller = person(c);
    if ('refusal' in caller) return caller.refusal;
    const body = PatchAgentPermissionsBodySchema.safeParse(readJsonBody(c));
    if (!body.success) return c.json(validationFailureBody(body.error), 400);
    const id = c.req.param('id');
    try {
      const changes = await permissions.setAgent(id, body.data, caller.writer);
      return c.json({ changes, permissions: await permissions.getAgent(id) });
    } catch (err) {
      return sendPermissionError(c, err);
    }
  });

  return router;
}
