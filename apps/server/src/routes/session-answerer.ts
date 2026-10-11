import type { RequestHandler } from 'express';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import {
  ApprovalRequestSchema,
  BatchApprovalRequestSchema,
  SubmitAnswersRequestSchema,
} from '@dorkos/shared/schemas';
import { parseSessionId, sendError } from '../lib/route-utils.js';
import { requirePersonToAnswer } from './session-decision-caller.js';

/**
 * Who is answering a prompt, named on the receipt (DOR-2335): split out of
 * `sessions.ts`, whose answer routes all ask it.
 *
 * @module routes/session-answerer
 */
import type { Response } from 'express';
import { getUserById, readOwnerAccount, type RequestUser } from '../services/core/auth/index.js';
import { resolveAnswererName } from '../services/identity/operator-profile.js';
import { configManager } from '../services/core/config-manager.js';
import { logger } from '../lib/logger.js';

/**
 * What to call whoever is answering, so the receipt in every OTHER window can
 * name them instead of saying only "Already answered at 2:01".
 *
 * Runs only after `requirePersonToAnswer` (in `sessions.ts`) has already decided the caller
 * is a person, which is what makes the answer honest: this resolves a NAME, not
 * an identity, and would be a claim about who acted if anything else could get
 * this far.
 *
 * The name is read here rather than sent by the client for the same reason a
 * room's author is (`routes/room-caller.ts`): a caller that could name itself
 * could sign somebody else's decision. Under login-on that is the signed-in
 * account; with login off it is whoever owns this install, and on an install
 * with no accounts at all it is the name the person told DorkOS to call them.
 * When none of those exists there is nothing honest to print, and the receipt
 * falls back to the unnamed sentence.
 *
 * **This install has exactly one person in it** (ADR 260727-184933 D6), so the
 * name is that person's however they reached the cockpit. It becomes a real
 * lookup the day DorkOS has more than one, which is the same day the Ask needs
 * a per-caller entitlement filter.
 *
 * @param res - The response carrying `sessionGate`'s resolved user.
 * @returns The name to put on the receipt, or `undefined` when none is known or
 *   the lookup failed.
 */
export function answeredBy(res: Response): string | undefined {
  const user = res.locals.user as RequestUser | undefined;
  try {
    return resolveAnswererName({
      account: () => (user ? getUserById(user.userId) : readOwnerAccount()),
      configDisplayName: () => configManager.get('profile')?.displayName ?? null,
    });
  } catch (err) {
    // Two disk reads for a cosmetic label sit inside the path that decides
    // whether a tool runs. A locked database or an unreadable config must cost
    // the receipt its name, never the person their answer, so the throw is
    // swallowed here rather than 500ing an approve.
    logger.warn('[POST /answer] could not resolve who is answering; the receipt goes unnamed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

export const sessionApproveHandler: RequestHandler = async (req, res) => {
  const refusal = requirePersonToAnswer(req, res);
  if (refusal) return res.status(refusal.status).json({ error: refusal.error, code: refusal.code });

  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = ApprovalRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  }
  const { toolCallId, alwaysAllow } = parsed.data;
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  const answeredByName = answeredBy(res);
  const approved = runtime.approveTool(sessionId, toolCallId, true, {
    alwaysAllow,
    ...(answeredByName ? { answeredBy: answeredByName } : {}),
  });
  if (!approved) {
    if (runtime.hasSession(sessionId)) {
      return sendError(res, 409, 'Interaction already resolved', 'INTERACTION_ALREADY_RESOLVED');
    }
    return sendError(res, 404, 'No pending approval', 'NO_PENDING_APPROVAL');
  }
  res.json({ ok: true });
};

export const sessionDenyHandler: RequestHandler = async (req, res) => {
  // Guarded for the same reason as approve, not as a symmetry: an agent that can
  // deny can suppress a person's decision and bury the card that would have told
  // them. Same argument the capability approvals' deny route makes.
  const refusal = requirePersonToAnswer(req, res);
  if (refusal) return res.status(refusal.status).json({ error: refusal.error, code: refusal.code });

  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = ApprovalRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  }
  const { toolCallId, reason } = parsed.data;
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  // A blank field is not a reason. Normalising here keeps every runtime and the
  // receipt copy from having to re-decide what an empty string means.
  const denyReason = reason?.trim() ? reason.trim() : undefined;
  const answeredByName = answeredBy(res);
  const denied = runtime.approveTool(sessionId, toolCallId, false, {
    denyReason,
    ...(answeredByName ? { answeredBy: answeredByName } : {}),
  });
  if (!denied) {
    if (runtime.hasSession(sessionId)) {
      return sendError(res, 409, 'Interaction already resolved', 'INTERACTION_ALREADY_RESOLVED');
    }
    return sendError(res, 404, 'No pending approval', 'NO_PENDING_APPROVAL');
  }
  res.json({ ok: true });
};

export const sessionBatchApproveHandler: RequestHandler = async (req, res) => {
  const refusal = requirePersonToAnswer(req, res);
  if (refusal) return res.status(refusal.status).json({ error: refusal.error, code: refusal.code });

  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = BatchApprovalRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  }
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  const answeredByName = answeredBy(res);
  const results = parsed.data.toolCallIds.map((id) => ({
    toolCallId: id,
    ok: runtime.approveTool(sessionId, id, true, {
      ...(answeredByName ? { answeredBy: answeredByName } : {}),
    }),
  }));
  res.json({ results });
};

export const sessionBatchDenyHandler: RequestHandler = async (req, res) => {
  const refusal = requirePersonToAnswer(req, res);
  if (refusal) return res.status(refusal.status).json({ error: refusal.error, code: refusal.code });

  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = BatchApprovalRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  }
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  const answeredByName = answeredBy(res);
  const results = parsed.data.toolCallIds.map((id) => ({
    toolCallId: id,
    ok: runtime.approveTool(sessionId, id, false, {
      ...(answeredByName ? { answeredBy: answeredByName } : {}),
    }),
  }));
  res.json({ results });
};

export const sessionSubmitAnswersHandler: RequestHandler = async (req, res) => {
  // A question is answered by a person too. The three kinds of prompt share one
  // bar, because they are one object to whoever is being asked.
  const refusal = requirePersonToAnswer(req, res);
  if (refusal) return res.status(refusal.status).json({ error: refusal.error, code: refusal.code });

  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = SubmitAnswersRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  }
  const { toolCallId, answers } = parsed.data;
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  const answeredByName = answeredBy(res);
  const ok = runtime.submitAnswers(sessionId, toolCallId, answers, {
    ...(answeredByName ? { answeredBy: answeredByName } : {}),
  });
  if (!ok) {
    if (runtime.hasSession(sessionId)) {
      return sendError(res, 409, 'Interaction already resolved', 'INTERACTION_ALREADY_RESOLVED');
    }
    return sendError(res, 404, 'No pending question', 'NO_PENDING_QUESTION');
  }
  res.json({ ok: true });
};
