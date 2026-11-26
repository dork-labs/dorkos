/**
 * The permission routes (spec `agent-permissions` D10): read the default layer,
 * change the preset, the defaults and one agent, read the history, and undo one
 * change from it (D14). One agent's settings and level are read on the
 * capability mount (`services/core/permissions/agent-permission-views.ts`).
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
 * From Wi-Fi a write may lower permissions but never raise them, and an Undo is
 * refused (DOR-3037, `wifi-raise-guard.ts`). Anywhere else, a raise and an Undo
 * (which can put back a looser setting) wait for the owner to confirm it's them
 * (DOR-4355); lowering stays immediate.
 *
 * With login off the write is recorded as `local-trust` and labelled "Someone on
 * this computer", because DorkOS cannot tell the person at the keyboard from any
 * other program running as the same user. That is the same residual every
 * login-off operator route carries; turning login on closes it.
 *
 * @module routes/permissions
 */
import { Hono, type Context } from 'hono';
import {
  PatchAgentPermissionsBodySchema,
  PatchPermissionDefaultsBodySchema,
  PermissionHistoryQuerySchema,
  SetPermissionPresetBodySchema,
  UndoPermissionChangeBodySchema,
} from '@dorkos/shared/permissions';
import { readCallerAuthority, requireOperatorCookieUnderLogin } from '../lib/caller-authority.js';
import type { ApiEnv } from '../http/api-chain.js';
import {
  problem,
  problemBody,
  readJsonBody,
  sendProblem,
  validationProblem,
} from '@dorkos/http-kit';
import type { Problem, ProblemCode } from '@dorkos/shared/problem';
import { honoRequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import { runFrontDoorWrite } from './front-door-step-up.js';
import {
  resolveDecisionAuthority,
  type LoginEnabledLookup,
} from '../services/core/approvals/index.js';
import { getUserById, readOwnerAccount } from '../services/core/auth/index.js';
import { configManager } from '../services/core/config-manager.js';
import { isFromWifi } from '../services/core/auth/sessions/wifi-level.js';
import {
  agentPatchRaises,
  defaultsPatchRaises,
  presetRaises,
  WIFI_UNDO_REFUSAL,
  wifiRaiseRefusal,
} from '../services/core/auth/sessions/wifi-raise-guard.js';
import { resolveAnswererName } from '../services/identity/operator-profile.js';
import type { RequestUser } from '../services/core/auth/session-gate.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import {
  PermissionError,
  type PermissionErrorCode,
  listPermissionHistory,
  personWriter,
  type PermissionService,
  type PermissionWriter,
} from '../services/core/permissions/index.js';

/**
 * Whether the request came over Wi-Fi, where a write may lower permissions but
 * never raise them (DOR-3037, `wifi-raise-guard.ts`).
 */
function fromWifi(c: Context<ApiEnv>): boolean {
  return isFromWifi(honoRequestFacts(c));
}

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
  // An agent, the caller holding the approval token, or nobody signed in.
  if (!authority.allowed) {
    const code = authority.code === 'AUTH_REQUIRED' ? 'unauthenticated' : 'person_only';
    return { refusal: problem(c, code, { detail: ONLY_A_PERSON }) };
  }
  const cookie = requireOperatorCookieUnderLogin(facts, 'permissions', isLoginEnabled);
  if (cookie) return { refusal: problem(c, 'person_only', { detail: ONLY_A_PERSON }) };
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

/**
 * The problem code and fixed sentence for each refusal of the permission
 * service. The service's own sentences name the caller's input, so they stay
 * with the MCP tools and the log.
 */
const PERMISSION_PROBLEM: Record<PermissionErrorCode, { code: ProblemCode; detail: string }> = {
  UNKNOWN_AREA: { code: 'invalid_request', detail: 'There’s no permission area by that name.' },
  INVALID_STATE: { code: 'invalid_request', detail: 'Choose Allowed, Ask or Blocked.' },
  FLOOR_NEVER_ALLOWED: {
    code: 'invalid_request',
    detail: 'Safety limits and Reach & secrets are never Allowed. Choose Ask or Blocked.',
  },
  UNKNOWN_ACTION: { code: 'invalid_request', detail: 'There’s no action by that name.' },
  ACTION_HAS_NO_AREA: {
    code: 'invalid_request',
    detail: 'That action is always allowed, so it has no permission to set.',
  },
  ALWAYS_ASKS: {
    code: 'invalid_request',
    detail: 'That action always shows its changes first. Choose Ask or Blocked.',
  },
  INVALID_STOP: { code: 'invalid_request', detail: 'That isn’t a Files & commands stop.' },
  UNKNOWN_AGENT: { code: 'agent_not_found', detail: 'No agent with that id.' },
  UNKNOWN_EVENT: { code: 'not_found', detail: 'That change isn’t in the history.' },
  NOT_UNDOABLE: {
    code: 'conflict',
    detail: 'This change can’t be undone. Change the setting instead.',
  },
  PERMISSIONS_CHANGED: {
    code: 'precondition_failed',
    detail: 'Permissions changed while you were choosing. Look again, then choose.',
  },
  // With `conflicts`: what changed since, so the person can set it back anyway.
  UNDO_CONFLICT: {
    code: 'precondition_failed',
    detail: 'This has changed since. Set it back anyway?',
  },
};

/**
 * The problem document for a refusal of the permission service. Shared with
 * the approval grant route, whose Always allow writes a permission too.
 *
 * @param err - The refusal.
 * @returns The problem document, with any `conflicts` the refusal carries.
 */
export function permissionProblemBody(err: PermissionError): Problem {
  const { code, detail } = PERMISSION_PROBLEM[err.code];
  return problemBody(code, { detail, ...(err.details ? { extensions: err.details } : {}) });
}

/** Answer a service refusal, or rethrow anything else. */
function sendPermissionError(c: Context<ApiEnv>, err: unknown): Response {
  if (err instanceof PermissionError) return sendProblem(c, permissionProblemBody(err));
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
 * @returns The routes serving `/permissions*` and `PATCH /agents/:id/permissions`; one agent's
 *   reads are capabilities (`services/core/permissions/agent-permission-views.ts`).
 */
export function createPermissionsRoutes(deps: PermissionsRouterDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  const { permissions, activity, isLoginEnabled } = deps;
  const person = (c: Context<ApiEnv>) => requirePerson(c, isLoginEnabled);
  /** A raise waits for the owner to confirm; anything else runs now. */
  const raiseOrRun = (
    c: Context<ApiEnv>,
    raises: boolean,
    held: { target: string; input: unknown; reason: string },
    run: () => Promise<Response>
  ): Promise<Response> =>
    raises
      ? runFrontDoorWrite(c, {
          kind: 'permissions.raise',
          ...held,
          subject: 'what agents may do',
          run,
        })
      : run();

  router.get('/permissions', async (c) => {
    return c.json(await permissions.getOverview());
  });

  router.get('/permissions/history', async (c) => {
    const query = PermissionHistoryQuerySchema.safeParse(readQuery(c));
    if (!query.success) return validationProblem(c, query.error);
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
    if (!body.success) return validationProblem(c, body.error);
    const now = await permissions.getOverview();
    const raises = presetRaises(body.data.preset, body.data.applyToAgents, now);
    if (fromWifi(c) && raises) {
      return problem(c, 'not_from_wifi', { detail: wifiRaiseRefusal().error });
    }
    const run = async () => {
      try {
        // The direction was judged against `now`; a move made meanwhile is refused (409).
        const changes = await permissions.setPreset(
          { ...body.data, expect: { preset: now.preset, defaults: now.defaults } },
          caller.writer
        );
        return c.json({ changes, permissions: await permissions.getOverview() });
      } catch (err) {
        return sendPermissionError(c, err);
      }
    };
    return raiseOrRun(
      c,
      raises,
      { target: 'preset', input: body.data, reason: 'Raise what every agent may do.' },
      run
    );
  });

  router.patch('/permissions/defaults', async (c) => {
    const caller = person(c);
    if ('refusal' in caller) return caller.refusal;
    const body = PatchPermissionDefaultsBodySchema.safeParse(readJsonBody(c));
    if (!body.success) return validationProblem(c, body.error);
    const raises = defaultsPatchRaises(body.data, await permissions.getOverview());
    if (fromWifi(c) && raises) {
      return problem(c, 'not_from_wifi', { detail: wifiRaiseRefusal().error });
    }
    const run = async () => {
      try {
        const changes = await permissions.setDefaults(body.data, caller.writer);
        return c.json({ changes, permissions: await permissions.getOverview() });
      } catch (err) {
        return sendPermissionError(c, err);
      }
    };
    return raiseOrRun(
      c,
      raises,
      { target: 'defaults', input: body.data, reason: 'Raise what agents may do by default.' },
      run
    );
  });

  // Undo one recorded change: a new change, audited like any other. A key
  // that changed since is a conflict the person decides on (409, then `force`).
  router.post('/permissions/history/:eventId/undo', async (c) => {
    const caller = person(c);
    if ('refusal' in caller) return caller.refusal;
    // An empty POST reads as `{}`, as Express 5's undefined `req.body` did: a plain Undo.
    const body = UndoPermissionChangeBodySchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!body.success) return validationProblem(c, body.error);
    // An Undo can put back a looser setting, and which way it goes is only
    // known once it runs, so from Wi-Fi it is refused (DOR-3037).
    if (fromWifi(c)) return problem(c, 'not_from_wifi', { detail: WIFI_UNDO_REFUSAL });
    const eventId = c.req.param('eventId');
    const run = async () => {
      try {
        return c.json(await permissions.undo(eventId, body.data, caller.writer));
      } catch (err) {
        return sendPermissionError(c, err);
      }
    };
    return raiseOrRun(
      c,
      true,
      { target: eventId, input: body.data, reason: 'Undo a change to what agents may do.' },
      run
    );
  });

  router.patch('/agents/:id/permissions', async (c) => {
    const caller = person(c);
    if ('refusal' in caller) return caller.refusal;
    const body = PatchAgentPermissionsBodySchema.safeParse(readJsonBody(c));
    if (!body.success) return validationProblem(c, body.error);
    const id = c.req.param('id');
    let raises: boolean;
    try {
      raises = agentPatchRaises(body.data, await permissions.getAgent(id));
    } catch (err) {
      return sendPermissionError(c, err);
    }
    if (fromWifi(c) && raises) {
      return problem(c, 'not_from_wifi', { detail: wifiRaiseRefusal().error });
    }
    const run = async () => {
      try {
        const changes = await permissions.setAgent(id, body.data, caller.writer);
        return c.json({ changes, permissions: await permissions.getAgent(id) });
      } catch (err) {
        return sendPermissionError(c, err);
      }
    };
    return raiseOrRun(
      c,
      raises,
      { target: id, input: body.data, reason: 'Raise what this agent may do.' },
      run
    );
  });

  return router;
}
