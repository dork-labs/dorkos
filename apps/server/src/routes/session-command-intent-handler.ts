/**
 * Handler for `POST /api/sessions/:id/command-intents/:intent` — the
 * runtime-fulfilled command-intent trigger (DOR-109, ADR-0273/ADR-0264),
 * extracted from `sessions.ts` (server-structure rule), mirroring
 * `session-ui-action-handler.ts`.
 *
 * A runtime-fulfilled intent (currently `compact`) is recognized client-side and
 * dispatched here — the client-native intents (`clear`, `context`) never reach
 * this route. This validates `:intent` against the runtime-fulfilled set,
 * resolves the session's runtime, and gates on
 * `capabilities.commandIntents[intent].supported`: an unsupported runtime is an
 * HONEST `422` (the adapter is NEVER called), never a silent no-op. When
 * supported, it drives `runtime.executeCommandIntent` through the durable
 * projector + session lock via {@link triggerCommandIntent} (trigger-only, `202`;
 * the compaction is delivered solely over `/events`, e.g. a `compact_boundary`).
 * A lock held by another turn `409`s SESSION_LOCKED, exactly like `/messages`.
 * The session must already exist (a compact operates on live context): mirroring
 * `/ui-action`, a session present in runtime storage cold-starts, one that exists
 * nowhere `404`s (this route never creates sessions).
 *
 * @module routes/session-command-intent-handler
 */
import type { Request, Response } from 'express';
import { COMMAND_INTENTS } from '@dorkos/shared/command-intents';
import type { RuntimeCommandIntentId } from '@dorkos/shared/command-intents';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { parseSessionId, sendError } from '../lib/route-utils.js';
import { DEFAULT_CWD } from '../lib/resolve-root.js';
import { logger } from '../lib/logger.js';
import {
  getOrCreateProjector,
  peekProjector,
  triggerCommandIntent,
} from '../services/session/index.js';

/**
 * Narrow an arbitrary `:intent` param to a runtime-fulfilled intent id, reading
 * the shared registry so it stays the single source of truth (fulfillment
 * `'runtime'` ⟺ {@link RuntimeCommandIntentId} by design). Returns `null` for an
 * unknown token or a client-native intent that shouldn't hit this route.
 *
 * @param param - The raw `:intent` route param (Express types it loosely).
 */
function parseRuntimeIntent(param: unknown): RuntimeCommandIntentId | null {
  const descriptor = COMMAND_INTENTS.find(
    (intent) => intent.id === param && intent.fulfillment === 'runtime'
  );
  return descriptor ? (descriptor.id as RuntimeCommandIntentId) : null;
}

/**
 * Express handler for `POST /api/sessions/:id/command-intents/:intent`. Mounted by
 * `sessions.ts` under `asyncHandler`; see the module doc for semantics.
 *
 * @param req - The Express request (`:id` + `:intent` route params; no body)
 * @param res - The Express response (202 trigger / 400 / 404 / 409 / 422)
 */
export async function sessionCommandIntentHandler(req: Request, res: Response): Promise<void> {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  // Validate the intent against the runtime-fulfilled set. An unknown token (or a
  // client-native intent that shouldn't reach the server) is a client bug → 422.
  const intent = parseRuntimeIntent(req.params.intent);
  if (!intent) {
    return sendError(
      res,
      422,
      `Unknown command intent: ${String(req.params.intent)}`,
      'INVALID_COMMAND_INTENT'
    );
  }

  const runtime = await runtimeRegistry.resolveForSession(sessionId);

  // The session must already exist — a compact operates on live context. Mirror
  // /ui-action's cold-start probe (the live map empties on restart/eviction,
  // DOR-302): a session present in runtime storage proceeds; one that exists
  // nowhere 404s. Probe with the projector's cwd (minted by the /events connect)
  // else the default root.
  if (!runtime.hasSession(sessionId)) {
    const probeCwd = peekProjector(sessionId)?.cwd ?? DEFAULT_CWD;
    const stored = await runtime.getSession(probeCwd, sessionId);
    if (!stored) {
      return sendError(res, 404, 'Session not found', 'SESSION_NOT_FOUND');
    }
  }

  // Honest capability gate: an unsupported runtime is a 422 and the adapter's
  // executeCommandIntent is NEVER called (the composer keeps the text on the
  // client; this is the server half of that honesty).
  const caps = runtime.getCapabilities();
  if (!caps.commandIntents[intent].supported) {
    return sendError(
      res,
      422,
      `${caps.type} does not support the ${intent} command intent`,
      'COMMAND_INTENT_UNSUPPORTED'
    );
  }

  const clientId = (req.headers['x-client-id'] as string) || crypto.randomUUID();
  // No request body carries a cwd (the trigger POST is empty), so source it from
  // the session's live projector (set by the /events connect / prior turn).
  const cwd = peekProjector(sessionId)?.cwd ?? DEFAULT_CWD;

  logger.info('[POST /command-intents] trigger', { sessionId, intent });

  // Persist completed runs for LOG-BACKED runtimes (DOR-189), mirroring
  // /messages so the compact_boundary survives a restart.
  const projector = getOrCreateProjector(sessionId, cwd, {
    persist: caps.logBackedHistory === true,
  });

  const result = triggerCommandIntent({
    sessionId,
    clientId,
    intent,
    cwd,
    projector,
    deps: {
      acquireLock: (sid, cid, lifecycle, token) => runtime.acquireLock(sid, cid, lifecycle, token),
      releaseLock: (sid, cid, token) => runtime.releaseLock(sid, cid, token),
      executeCommandIntent: (sid, i, o) => runtime.executeCommandIntent(sid, i, o),
      interruptQuery: (sid) => runtime.interruptQuery(sid),
    },
    onError: (err) => {
      logger.warn('[POST /command-intents] detached run error', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    },
  });

  if (!result.accepted) {
    const lockInfo = runtime.getLockInfo(sessionId);
    logger.warn('[POST /command-intents] session locked', {
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

  res.status(202).json({ sessionId });
}
