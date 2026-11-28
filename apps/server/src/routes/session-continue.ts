/**
 * The HTTP half of "your account ran out: continue elsewhere, or wait" (spec
 * `claude-account-fleet` D9 "Endpoints"). Four thin handlers over
 * `services/session/fleet/continue-service.ts`, mounted on the sessions router:
 *
 * - `GET  /api/sessions/:id/continue-options` → `{ plan, ranking, advised }`
 * - `POST /api/sessions/:id/continue` `{ account?, runtime?, model? }` → `202 { sessionId? }`
 * - `POST /api/sessions/:id/wait` `{ autoResume? }` → `{ plan }`
 * - `DELETE /api/sessions/:id/continue` → `{ plan }`
 * - `GET  /api/sessions/:id/limit-history` → `{ entries }` (spec
 *   `claude-account-ui` §7.1): how past limits ended, for the transcript
 *
 * The history is a read of what already happened on screen, so it is not
 * people-only like the four decisions; like every session read, it is judged
 * against the directory boundary.
 *
 * **A person is the gate.** Each route refuses a caller presenting an agent
 * identity, as the session canvas routes do: these decisions spend another
 * account or hold a session, and an agent's path to an account is the
 * `session_start` tool, which the account advisor gates. Continuing onto DorkOS
 * credits asks one bar more: the person must own this install, because it
 * spends the DorkOS account's money (`routes/cloud-owner-bar.ts`).
 *
 * @module routes/session-continue
 */
import type { Context } from 'hono';
import type { MeshCore } from '@dorkos/mesh';
import { CREDITS_ACCOUNT_ID, type LimitHistoryResponse } from '@dorkos/shared/account-usage';
import { ContinueSessionRequestSchema, WaitForResetRequestSchema } from '@dorkos/shared/schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { problem, readJsonBody, sendProblem, validationProblem } from '@dorkos/http-kit';
import { readQuery } from '../http/request-query.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { wifiTurnCeiling } from '../services/core/auth/sessions/wifi-turn-ceiling.js';
import { boundaryRefusal, parseSessionId } from '../lib/route-utils.js';
import { logger } from '../lib/logger.js';
import {
  AmbiguousSessionError,
  SessionDiscoveryUnavailableError,
} from '../services/session/resolution/session-lookup-error.js';
import {
  ContinueError,
  cancelAutoContinue,
  continueOptions,
  continueSession,
  waitForReset,
} from '../services/session/fleet/continue-service.js';
import { CarryOverError } from '../services/session/fleet/carry-over.js';
import { AccountNotAllowedError } from '../services/core/usage/account-eligibility.js';
import { getSessionLimitStore } from '../services/session/fleet/session-limit-store.js';
import { resolveSessionCwdOrDefault } from '../services/session/index.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import type { RoomSessionPlacePort } from '../services/workspace/room-session-place.js';
import { resolveCaller } from './room-caller.js';
import { sendRoomError } from './room-error-response.js';
import { rejectUnknownModel } from './session-model-gate.js';
import { errorRefusalUnlessOwner } from './cloud-owner-bar.js';
import {
  accountNotAllowedReply,
  invalidSessionId,
  ownerRefusalReply,
  sessionNotFound,
} from './session-route-replies.js';

/** What continuing a session reads from the running server. */
export interface SessionContinueDeps {
  /** The agent registry, for the launch a handoff makes. */
  meshCore?: MeshCore;
  /** Where a room conversation runs, for a handoff in one. */
  roomSessionPlace?: RoomSessionPlacePort;
}

/**
 * The session id, once the caller is known to be a person; the refusal to
 * answer otherwise.
 */
function requirePersonAndSession(c: Context<ApiEnv>): string | Response {
  const sessionId = parseSessionId(c.req.param('id'));
  if (!sessionId) return invalidSessionId(c);
  let caller;
  try {
    caller = resolveCaller(honoRequestFacts(c));
  } catch (err) {
    // No caller was resolved, so no refusal here is worded for the owner.
    return sendRoomError(c, err, 'session-continue', () => false);
  }
  if (caller.kind !== 'human') {
    return problem(c, 'person_only', { detail: 'Only a person can move or hold a chat.' });
  }
  return sessionId;
}

/** The code a service refusal answers with, by the status it names. */
const REFUSAL_CODES = {
  400: 'invalid_request',
  409: 'conflict',
  503: 'temporarily_unavailable',
} as const;

/** Answer a refusal from the service, or a 500 for anything else. */
function continueErrorReply(c: Context<ApiEnv>, err: unknown, route: string): Response {
  if (err instanceof AccountNotAllowedError) return accountNotAllowedReply(c, err);
  if (err instanceof ContinueError || err instanceof CarryOverError) {
    return problem(c, REFUSAL_CODES[err.status], { detail: err.message });
  }
  logger.error(`[session-continue] ${route} failed`, {
    err: err instanceof Error ? err.message : String(err),
  });
  return problem(c, 'internal_error', { detail: 'Something went wrong, and nothing was changed.' });
}

/**
 * `GET /api/sessions/:id/continue-options` — the accounts a limited session
 * could continue on, in order, with the session's current plan.
 *
 * @param c - The request context.
 */
export async function continueOptionsHandler(c: Context<ApiEnv>): Promise<Response> {
  const sessionId = requirePersonAndSession(c);
  if (sessionId instanceof Response) return sessionId;
  try {
    return c.json(await continueOptions(sessionId));
  } catch (err) {
    return continueErrorReply(c, err, 'continue-options');
  }
}

/** What continuing on DorkOS credits says to a caller that is not the owner. */
const CONTINUE_ON_CREDITS = {
  personOnly: 'Only you can move this chat onto your DorkOS credits, from the DorkOS app.',
  action: 'move a chat onto DorkOS credits',
};

/**
 * `POST /api/sessions/:id/continue` — continue a limited session on another
 * account or another model.
 *
 * @param deps - What a handoff launches with.
 * @returns The handler.
 */
export function continueSessionHandler(
  deps: SessionContinueDeps
): (c: Context<ApiEnv>) => Promise<Response> {
  return async (c) => {
    const sessionId = requirePersonAndSession(c);
    if (sessionId instanceof Response) return sessionId;
    const parsed = ContinueSessionRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!parsed.success) return validationProblem(c, parsed.error);
    // Moving onto DorkOS credits spends the account's money, so it is the
    // owner's call alone, like every other credits choice (DOR-2652).
    if (parsed.data.account === CREDITS_ACCOUNT_ID) {
      const refusal = errorRefusalUnlessOwner(honoRequestFacts(c), CONTINUE_ON_CREDITS);
      if (refusal) return ownerRefusalReply(c, refusal);
    }
    try {
      const result = await continueSession(sessionId, parsed.data, {
        meshCore: deps.meshCore,
        roomSessionPlace: deps.roomSessionPlace,
        clientId: c.req.header('x-client-id') || crypto.randomUUID(),
        checkModel: rejectUnknownModel,
        // From Wi-Fi, the continuing turn runs at the runtime's default at most (DOR-3037).
        ...wifiTurnCeiling(honoRequestFacts(c)),
      });
      return c.json(result, 202);
    } catch (err) {
      return continueErrorReply(c, err, 'continue');
    }
  };
}

/**
 * `POST /api/sessions/:id/wait` — wait for the account's reset.
 *
 * @param c - The request context.
 */
export async function waitForResetHandler(c: Context<ApiEnv>): Promise<Response> {
  const sessionId = requirePersonAndSession(c);
  if (sessionId instanceof Response) return sessionId;
  const parsed = WaitForResetRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
  if (!parsed.success) return validationProblem(c, parsed.error);
  try {
    return c.json({ plan: await waitForReset(sessionId, parsed.data) });
  } catch (err) {
    return continueErrorReply(c, err, 'wait');
  }
}

/**
 * `DELETE /api/sessions/:id/continue` — cancel a pending handoff.
 *
 * @param c - The request context.
 */
export async function cancelContinueHandler(c: Context<ApiEnv>): Promise<Response> {
  const sessionId = requirePersonAndSession(c);
  if (sessionId instanceof Response) return sessionId;
  try {
    return c.json({ plan: await cancelAutoContinue(sessionId) });
  } catch (err) {
    return continueErrorReply(c, err, 'continue (cancel)');
  }
}

/**
 * `GET /api/sessions/:id/limit-history` — how the session's recent usage
 * limits ended, at most 20, oldest first; 404 for a session this server does
 * not know, 403 for one whose directory is outside the boundary.
 *
 * @param c - The request context.
 */
export async function limitHistoryHandler(c: Context<ApiEnv>): Promise<Response> {
  const sessionId = parseSessionId(c.req.param('id'));
  if (!sessionId) return invalidSessionId(c);
  // The same boundary judgement as `GET /:id/events`: a directory the caller
  // named first, else the one the session's runtime places it in.
  const cwdParam = (readQuery(c).cwd as string) || undefined;
  let cwd: string;
  try {
    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    cwd = await resolveSessionCwdOrDefault(runtime, sessionId, cwdParam);
  } catch (err) {
    if (err instanceof AmbiguousSessionError || err instanceof SessionDiscoveryUnavailableError)
      return err instanceof AmbiguousSessionError
        ? problem(c, 'conflict', { detail: err.message })
        : problem(c, 'temporarily_unavailable', { detail: err.message });
    throw err;
  }
  const outside = await boundaryRefusal(cwd, { allowDorkHome: true });
  if (outside) return sendProblem(c, outside);
  const store = getSessionLimitStore();
  if (!store?.knowsSession(sessionId)) {
    return sessionNotFound(c);
  }
  try {
    return c.json({ entries: store.history(sessionId) } satisfies LimitHistoryResponse);
  } catch (err) {
    logger.error('[session-continue] limit-history failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return problem(c, 'internal_error', { detail: 'Couldn’t read the limit history.' });
  }
}
