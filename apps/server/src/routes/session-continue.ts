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
 * `session_start` tool, which the account advisor gates.
 *
 * @module routes/session-continue
 */
import type { Request, Response } from 'express';
import type { MeshCore } from '@dorkos/mesh';
import type { LimitHistoryResponse } from '@dorkos/shared/account-usage';
import { ContinueSessionRequestSchema, WaitForResetRequestSchema } from '@dorkos/shared/schemas';
import { assertBoundary, parseSessionId, sendError } from '../lib/route-utils.js';
import { logger } from '../lib/logger.js';
import {
  ContinueError,
  cancelAutoContinue,
  continueOptions,
  continueSession,
  waitForReset,
} from '../services/session/fleet/continue-service.js';
import { CarryOverError } from '../services/session/fleet/carry-over.js';
import { getSessionLimitStore } from '../services/session/fleet/session-limit-store.js';
import { callerNamedCwd, resolveSessionCwdOrDefault } from '../services/session/index.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import type { RoomSessionPlacePort } from '../services/workspace/room-session-place.js';
import { resolveCaller } from './room-caller.js';
import { sendRoomError } from './room-error-response.js';
import { rejectUnknownModel } from './session-model-gate.js';

/**
 * The session id, once the caller is known to be a person; `null` after
 * answering a refusal.
 */
function requirePersonAndSession(req: Request, res: Response): string | null {
  const sessionId = parseSessionId(req.params.id as string);
  if (!sessionId) {
    sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');
    return null;
  }
  let caller;
  try {
    caller = resolveCaller(req, res);
  } catch (err) {
    sendRoomError(res, err, 'session-continue');
    return null;
  }
  if (caller.kind !== 'human') {
    sendError(res, 403, 'Only a person can move or hold a session', 'PEOPLE_ONLY');
    return null;
  }
  return sessionId;
}

/** Answer a refusal from the service, or a 500 for anything else. */
function sendContinueError(res: Response, err: unknown, route: string): void {
  if (err instanceof ContinueError || err instanceof CarryOverError) {
    sendError(res, err.status, err.message, err.code);
    return;
  }
  logger.error(`[session-continue] ${route} failed`, {
    err: err instanceof Error ? err.message : String(err),
  });
  sendError(res, 500, 'Something went wrong, and nothing was changed.', 'CONTINUE_ERROR');
}

/**
 * `GET /api/sessions/:id/continue-options` — the accounts a limited session
 * could continue on, in order, with the session's current plan.
 *
 * @param req - The request.
 * @param res - The response.
 */
export async function continueOptionsHandler(req: Request, res: Response): Promise<void> {
  const sessionId = requirePersonAndSession(req, res);
  if (!sessionId) return;
  try {
    res.json(await continueOptions(sessionId));
  } catch (err) {
    sendContinueError(res, err, 'continue-options');
  }
}

/**
 * `POST /api/sessions/:id/continue` — continue a limited session on another
 * account or another model.
 *
 * @param req - The request.
 * @param res - The response.
 */
export async function continueSessionHandler(req: Request, res: Response): Promise<void> {
  const sessionId = requirePersonAndSession(req, res);
  if (!sessionId) return;
  const parsed = ContinueSessionRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  try {
    const result = await continueSession(sessionId, parsed.data, {
      meshCore: req.app.locals.meshCore as MeshCore | undefined,
      roomSessionPlace: req.app.locals.roomSessionPlace as RoomSessionPlacePort | undefined,
      clientId: (req.headers['x-client-id'] as string) || crypto.randomUUID(),
      checkModel: rejectUnknownModel,
    });
    res.status(202).json(result);
  } catch (err) {
    sendContinueError(res, err, 'continue');
  }
}

/**
 * `POST /api/sessions/:id/wait` — wait for the account's reset.
 *
 * @param req - The request.
 * @param res - The response.
 */
export async function waitForResetHandler(req: Request, res: Response): Promise<void> {
  const sessionId = requirePersonAndSession(req, res);
  if (!sessionId) return;
  const parsed = WaitForResetRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  try {
    res.json({ plan: await waitForReset(sessionId, parsed.data) });
  } catch (err) {
    sendContinueError(res, err, 'wait');
  }
}

/**
 * `POST /api/sessions/:id/continue/cancel` — cancel a pending handoff.
 *
 * @param req - The request.
 * @param res - The response.
 */
export async function cancelContinueHandler(req: Request, res: Response): Promise<void> {
  const sessionId = requirePersonAndSession(req, res);
  if (!sessionId) return;
  try {
    res.json({ plan: await cancelAutoContinue(sessionId) });
  } catch (err) {
    sendContinueError(res, err, 'continue/cancel');
  }
}

/**
 * `GET /api/sessions/:id/limit-history` — how the session's recent usage
 * limits ended, at most 20, oldest first; 404 for a session this server does
 * not know, 403 for one whose directory is outside the boundary.
 *
 * @param req - The request.
 * @param res - The response.
 */
export async function limitHistoryHandler(req: Request, res: Response): Promise<void> {
  const sessionId = parseSessionId(req.params.id as string);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');
  // The same boundary judgement as `GET /:id/events`: a directory the caller
  // named first, else the one the session's runtime places it in.
  const cwdParam = (req.query.cwd as string) || undefined;
  if (callerNamedCwd(cwdParam) && !(await assertBoundary(cwdParam, res, { allowDorkHome: true })))
    return;
  if (!callerNamedCwd(cwdParam)) {
    let cwd: string;
    try {
      const runtime = await runtimeRegistry.resolveForSession(sessionId);
      cwd = resolveSessionCwdOrDefault(runtime, sessionId, cwdParam);
    } catch (err) {
      logger.error('[session-continue] limit-history could not place the session', {
        err: err instanceof Error ? err.message : String(err),
      });
      return sendError(res, 500, 'Could not read the limit history.', 'LIMIT_HISTORY_ERROR');
    }
    if (!(await assertBoundary(cwd, res, { allowDorkHome: true }))) return;
  }
  const store = getSessionLimitStore();
  if (!store?.knowsSession(sessionId)) {
    return sendError(res, 404, 'Session not found', 'SESSION_NOT_FOUND');
  }
  try {
    res.json({ entries: store.history(sessionId) } satisfies LimitHistoryResponse);
  } catch (err) {
    logger.error('[session-continue] limit-history failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    sendError(res, 500, 'Could not read the limit history.', 'LIMIT_HISTORY_ERROR');
  }
}
