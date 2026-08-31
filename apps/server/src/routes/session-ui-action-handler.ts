/**
 * Handler for `POST /api/sessions/:id/ui-action` — the generative-UI widget
 * interactivity return channel (spec gen-ui-tier1 §3, PR E), extracted from
 * `sessions.ts` so that route file stays under the 500-line rule
 * (`max-lines` in `packages/eslint-config/base.js`), mirroring
 * `session-events-handler.ts`.
 *
 * A click on an `agent`-kind widget action lands here. Unlike `/submit-answers`
 * (which resolves a runtime interaction the agent is already blocked on), a
 * widget action starts a FRESH turn — so this mirrors `/messages` exactly: it
 * validates, formats a runtime-neutral `<ui_action>` block as the user message,
 * and hands it to the message dispatcher (trigger-only, 202; the turn streams over
 * `/events`, ADR-0264). Like `/messages`, a session absent from the live map
 * but present in runtime storage cold-starts (the map empties on restart and
 * eviction — DOR-302); unlike `/messages`, this route never CREATES sessions,
 * so an id that exists nowhere 404s.
 *
 * **Busy means the agent is still producing.** A click that lands while a turn
 * is running 409s SESSION_LOCKED — the person can see the agent working, and a
 * widget action run against a later turn is not the action they clicked. A click
 * that lands after the turn ENDED does not: the reply is finished and its buttons
 * are on screen, so the action is accepted and runs, even though the runtime may
 * still be closing the stream behind it (DOR-1239; the dispatcher's
 * `isStillProducing` draws that line).
 *
 * @module routes/session-ui-action-handler
 */
import type { Request, Response } from 'express';
import { UiActionRequestSchema } from '@dorkos/shared/schemas';
import { formatUiActionMessage } from '@dorkos/shared/ui-widget';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { parseSessionId, sendError } from '../lib/route-utils.js';
import { DEFAULT_CWD } from '../lib/resolve-root.js';
import { logger } from '../lib/logger.js';
import {
  dispatchMessage,
  getOrCreateProjector,
  peekProjector,
  persistenceModeFor,
} from '../services/session/index.js';

/**
 * Express handler for `POST /api/sessions/:id/ui-action`. Mounted directly by
 * `sessions.ts` (Express 5 forwards async rejections natively); see the
 * module doc for semantics.
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
  // The live session map is process-local: it empties on a server restart and
  // on session eviction, while the widget the user is clicking outlives both
  // (DOR-302). Mirror /messages: the dispatcher → `sendMessage` cold-starts a
  // map-less session from runtime storage, so a stored session proceeds. Only
  // a session that exists NOWHERE — no live entry AND no stored session — is a
  // client bug worth a 404 (a widget can only exist because a session rendered
  // it; this route never creates sessions). Probe storage with the request
  // cwd, else the projector's (minted by the /events connect with the
  // session's real cwd), else the default root.
  if (!runtime.hasSession(sessionId)) {
    const probeCwd = parsed.data.cwd ?? peekProjector(sessionId)?.cwd ?? DEFAULT_CWD;
    const stored = await runtime.getSession(probeCwd, sessionId);
    if (!stored) {
      return sendError(res, 404, 'Session not found', 'SESSION_NOT_FOUND');
    }
  }

  const clientId = (req.headers['x-client-id'] as string) || crypto.randomUUID();
  const content = formatUiActionMessage(parsed.data);
  const { cwd } = parsed.data;

  logger.info('[POST /ui-action] trigger', { sessionId, actionId: parsed.data.actionId });

  // Persist this turn (DOR-189), mirroring the /messages route: a
  // widget-triggered turn may be this process's FIRST touch of the projector
  // (e.g. right after a restart), and minting it without persistence would both
  // skip this turn's flush and — once its counter moves past 0 — block a later
  // hydrate for the process's lifetime.
  const projector = getOrCreateProjector(sessionId, cwd, {
    persist: persistenceModeFor(runtime.getCapabilities()),
  });
  if (cwd !== undefined) projector.cwd = cwd;

  const result = await dispatchMessage({
    sessionId,
    clientId,
    content,
    cwd,
    projector,
    runtime,
    // Refuse rather than queue, unlike `/messages`. A widget action answers the
    // turn it was rendered in; run minutes later against whatever a different
    // turn left behind, it is not the action the person clicked.
    whenBusy: 'refuse',
    onError: (err) => {
      logger.warn('[POST /ui-action] detached turn error', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    },
  });

  if (!result.accepted) {
    // Named by whatever actually refused it. Asking the runtime's lock here
    // instead — a DIFFERENT authority, under the id this request happened to
    // use rather than the canonical one the lock is keyed by — is how a 409
    // came to report `lockedBy: "unknown"` over a session somebody was using
    // (DOR-1239).
    const holder = result.refusedBy;
    logger.warn('[POST /ui-action] session busy', {
      sessionId,
      heldBy: holder?.clientId ?? 'unknown',
      // Usually the clicker's own tab: a person clicking a button in a reply
      // while the agent is working on the NEXT turn is the ordinary shape of
      // this refusal, not a cross-window conflict. Worth saying, so the line
      // does not read as a session locked against itself by mistake.
      ownTurn: holder?.clientId === clientId,
    });
    res.status(409).json({
      error: 'Session locked',
      code: 'SESSION_LOCKED',
      lockedBy: holder?.clientId ?? 'unknown',
      lockedAt: new Date(holder?.since ?? Date.now()).toISOString(),
    });
    return;
  }

  res.status(202).json({ sessionId: result.canonicalId });
}
