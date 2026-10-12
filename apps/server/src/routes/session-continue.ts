/**
 * The HTTP half of "your account ran out: continue elsewhere, or wait" (spec
 * `claude-account-fleet` D9 "Endpoints"). Four thin handlers over
 * `services/session/fleet/continue-service.ts`, mounted on the sessions router:
 *
 * - `GET  /api/sessions/:id/continue-options` → `{ plan, ranking, advised }`
 * - `POST /api/sessions/:id/continue` `{ account?, runtime?, model? }` → `202 { sessionId? }`
 * - `POST /api/sessions/:id/wait` `{ autoResume? }` → `{ plan }`
 * - `POST /api/sessions/:id/continue/cancel` → `{ plan }`
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
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { MeshCore } from '@dorkos/mesh';
import { CREDITS_ACCOUNT_ID, type LimitHistoryResponse } from '@dorkos/shared/account-usage';
import { ContinueSessionRequestSchema, WaitForResetRequestSchema } from '@dorkos/shared/schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { readQuery } from '../http/request-query.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { boundaryRefusal, errorBody, parseSessionId } from '../lib/route-utils.js';
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
import { roomErrorReply } from './room-error-response.js';
import { rejectUnknownModel } from './session-model-gate.js';
import { errorRefusalUnlessOwner } from './cloud-owner-bar.js';

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
  if (!sessionId) return c.json(errorBody('Invalid session ID', 'INVALID_SESSION_ID'), 400);
  let caller;
  try {
    caller = resolveCaller(honoRequestFacts(c));
  } catch (err) {
    // No caller was resolved, so no refusal here is worded for the owner.
    const reply = roomErrorReply(err, 'session-continue', () => false);
    return c.json(reply.body, reply.status as ContentfulStatusCode);
  }
  if (caller.kind !== 'human') {
    return c.json(errorBody('Only a person can move or hold a chat', 'PEOPLE_ONLY'), 403);
  }
  return sessionId;
}

/** Answer a refusal from the service, or a 500 for anything else. */
function continueErrorReply(c: Context<ApiEnv>, err: unknown, route: string): Response {
  if (err instanceof AccountNotAllowedError) return c.json(err.toBody(), 409);
  if (err instanceof ContinueError || err instanceof CarryOverError) {
    return c.json(errorBody(err.message, err.code), err.status as ContentfulStatusCode);
  }
  logger.error(`[session-continue] ${route} failed`, {
    err: err instanceof Error ? err.message : String(err),
  });
  return c.json(errorBody('Something went wrong, and nothing was changed.', 'CONTINUE_ERROR'), 500);
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
    if (!parsed.success) return c.json(errorBody('Invalid request', 'VALIDATION_ERROR'), 400);
    // Moving onto DorkOS credits spends the account's money, so it is the
    // owner's call alone, like every other credits choice (DOR-2652).
    if (parsed.data.account === CREDITS_ACCOUNT_ID) {
      const refusal = errorRefusalUnlessOwner(honoRequestFacts(c), CONTINUE_ON_CREDITS);
      if (refusal) return c.json(refusal, 403);
    }
    try {
      const result = await continueSession(sessionId, parsed.data, {
        meshCore: deps.meshCore,
        roomSessionPlace: deps.roomSessionPlace,
        clientId: c.req.header('x-client-id') || crypto.randomUUID(),
        checkModel: rejectUnknownModel,
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
  if (!parsed.success) return c.json(errorBody('Invalid request', 'VALIDATION_ERROR'), 400);
  try {
    return c.json({ plan: await waitForReset(sessionId, parsed.data) });
  } catch (err) {
    return continueErrorReply(c, err, 'wait');
  }
}

/**
 * `POST /api/sessions/:id/continue/cancel` — cancel a pending handoff.
 *
 * @param c - The request context.
 */
export async function cancelContinueHandler(c: Context<ApiEnv>): Promise<Response> {
  const sessionId = requirePersonAndSession(c);
  if (sessionId instanceof Response) return sessionId;
  try {
    return c.json({ plan: await cancelAutoContinue(sessionId) });
  } catch (err) {
    return continueErrorReply(c, err, 'continue/cancel');
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
  if (!sessionId) return c.json(errorBody('Invalid session ID', 'INVALID_SESSION_ID'), 400);
  // The same boundary judgement as `GET /:id/events`: a directory the caller
  // named first, else the one the session's runtime places it in.
  const cwdParam = (readQuery(c).cwd as string) || undefined;
  let cwd: string;
  try {
    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    cwd = await resolveSessionCwdOrDefault(runtime, sessionId, cwdParam);
  } catch (err) {
    if (err instanceof AmbiguousSessionError || err instanceof SessionDiscoveryUnavailableError)
      return c.json(
        errorBody(err.message, err.code),
        err instanceof AmbiguousSessionError ? 409 : 503
      );
    throw err;
  }
  const outside = await boundaryRefusal(cwd, { allowDorkHome: true });
  if (outside) return c.json(outside, 403);
  const store = getSessionLimitStore();
  if (!store?.knowsSession(sessionId)) {
    return c.json(errorBody('Session not found', 'SESSION_NOT_FOUND'), 404);
  }
  try {
    return c.json({ entries: store.history(sessionId) } satisfies LimitHistoryResponse);
  } catch (err) {
    logger.error('[session-continue] limit-history failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return c.json(errorBody('Could not read the limit history.', 'LIMIT_HISTORY_ERROR'), 500);
  }
}
