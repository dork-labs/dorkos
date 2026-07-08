/**
 * Handler for `POST /api/sessions/:id/ui-action` — the generative-UI widget
 * interactivity return channel (spec gen-ui-tier1 §3, PR E), extracted from
 * `sessions.ts` so that route file stays under the 500-line rule
 * (`.claude/rules/file-size.md`), mirroring `session-events-handler.ts`.
 *
 * A click on an `agent`-kind widget action lands here. Unlike `/submit-answers`
 * (which resolves a runtime interaction the agent is already blocked on), a
 * widget action starts a FRESH turn — so this mirrors `/messages` exactly: it
 * validates, formats a runtime-neutral `<ui_action>` block as the user message,
 * and hands it to `triggerTurn` (trigger-only, 202; the turn streams solely over
 * `/events`, ADR-0264). Busy-session handling matches `/messages`: a lock held
 * by another turn 409s SESSION_LOCKED (there is no server-side message queue —
 * the client surfaces the busy state and lets the user retry).
 *
 * @module routes/session-ui-action-handler
 */
import type { Request, Response } from 'express';
import { UiActionRequestSchema } from '@dorkos/shared/schemas';
import { formatUiActionMessage } from '@dorkos/shared/ui-widget';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { parseSessionId, sendError } from '../lib/route-utils.js';
import { logger } from '../lib/logger.js';
import { getOrCreateProjector, rekeyProjector, triggerTurn } from '../services/session/index.js';

/**
 * Express handler for `POST /api/sessions/:id/ui-action`. Mounted by
 * `sessions.ts` under `asyncHandler`; see the module doc for semantics.
 *
 * @param req - The Express request (`:id` route param + `UiActionRequest` body)
 * @param res - The Express response (202 trigger / 400 / 404 / 409)
 */
export async function sessionUiActionHandler(req: Request, res: Response): Promise<void> {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = UiActionRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    // Surface the first issue (e.g. the serialized-payload size cap) — every
    // field feeds the injected turn prompt, so a clear reject beats a generic one.
    const detail = parsed.error.issues[0]?.message ?? 'Invalid request';
    return sendError(res, 400, detail, 'VALIDATION_ERROR');
  }

  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  // A widget can only exist because an existing session rendered it; an action
  // for an unknown session is a client bug, not create-on-first-message.
  if (!runtime.hasSession(sessionId)) {
    return sendError(res, 404, 'Session not found', 'SESSION_NOT_FOUND');
  }

  const clientId = (req.headers['x-client-id'] as string) || crypto.randomUUID();
  const content = formatUiActionMessage(parsed.data);
  const { cwd } = parsed.data;

  logger.info('[POST /ui-action] trigger', { sessionId, actionId: parsed.data.actionId });

  const projector = getOrCreateProjector(sessionId, cwd);
  if (cwd !== undefined) projector.cwd = cwd;

  const result = await triggerTurn({
    sessionId,
    clientId,
    content,
    cwd,
    projector,
    deps: {
      acquireLock: (sid, cid, lifecycle, token) => runtime.acquireLock(sid, cid, lifecycle, token),
      releaseLock: (sid, cid, token) => runtime.releaseLock(sid, cid, token),
      sendMessage: (sid, text, opts) => runtime.sendMessage(sid, text, opts),
      interruptQuery: (sid) => runtime.interruptQuery(sid),
      getInternalSessionId: (sid) => runtime.getInternalSessionId(sid),
      rekeyProjector: (oldId, newId) => rekeyProjector(oldId, newId),
      getCapabilities: () => runtime.getCapabilities(),
    },
    onError: (err) => {
      logger.warn('[POST /ui-action] detached turn error', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    },
  });

  if (!result.accepted) {
    const lockInfo = runtime.getLockInfo(sessionId);
    logger.warn('[POST /ui-action] session locked', {
      sessionId,
      lockedBy: lockInfo?.clientId ?? 'unknown',
    });
    res.status(409).json({
      error: 'Session locked',
      code: 'SESSION_LOCKED',
      lockedBy: lockInfo?.clientId ?? 'unknown',
      lockedAt: lockInfo ? new Date(lockInfo.acquiredAt).toISOString() : new Date().toISOString(),
    });
    return;
  }

  res.status(202).json({ sessionId: result.canonicalId });
}
