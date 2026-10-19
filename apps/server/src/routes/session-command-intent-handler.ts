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
 * projector + session lock via the message dispatcher (trigger-only, `202`;
 * the compaction is delivered solely over `/events`, e.g. a `compact_boundary`).
 * A lock held by another turn `409`s SESSION_LOCKED, exactly like `/messages`.
 * The session must already exist (a compact operates on live context): mirroring
 * `/ui-action`, a session present in runtime storage cold-starts, one that exists
 * nowhere `404`s (this route never creates sessions).
 *
 * @module routes/session-command-intent-handler
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { COMMAND_INTENTS } from '@dorkos/shared/command-intents';
import type { RuntimeCommandIntentId } from '@dorkos/shared/command-intents';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { errorBody, parseSessionId } from '../lib/route-utils.js';
import { DEFAULT_CWD } from '../lib/resolve-root.js';
import { logger } from '../lib/logger.js';
import {
  dispatchCommandIntent,
  getOrCreateProjector,
  persistenceModeFor,
  peekProjector,
} from '../services/session/index.js';
import { continuationCeiling } from '../services/core/turn-power/chat-marks.js';

/**
 * Optional trigger body: trailing instructions the user typed after the intent
 * token (e.g. `/compact focus on the API changes`). An empty POST has no body,
 * so the whole body is optional.
 */
const CommandIntentBodySchema = z.object({ instructions: z.string().optional() }).optional();

/**
 * Narrow an arbitrary `:intent` param to a runtime-fulfilled intent id, reading
 * the shared registry so it stays the single source of truth (fulfillment
 * `'runtime'` ⟺ {@link RuntimeCommandIntentId} by design). Returns `null` for an
 * unknown token or a client-native intent that shouldn't hit this route.
 *
 * @param param - The raw `:intent` route param.
 */
function parseRuntimeIntent(param: unknown): RuntimeCommandIntentId | null {
  const descriptor = COMMAND_INTENTS.find(
    (intent) => intent.id === param && intent.fulfillment === 'runtime'
  );
  return descriptor ? (descriptor.id as RuntimeCommandIntentId) : null;
}

/**
 * Handler for `POST /api/sessions/:id/command-intents/:intent`, mounted by
 * `sessions.ts`; see the module doc for semantics.
 *
 * @param c - The request context (`:id` + `:intent` route params; optional
 *   JSON body `{ instructions?: string }`); answers 202 trigger / 400 / 404 /
 *   409 / 422
 */
export async function sessionCommandIntentHandler(c: Context<ApiEnv>): Promise<Response> {
  const sessionId = parseSessionId(c.req.param('id'));
  if (!sessionId) return c.json(errorBody('Invalid session ID', 'INVALID_SESSION_ID'), 400);

  // Validate the intent against the runtime-fulfilled set. An unknown token (or a
  // client-native intent that shouldn't reach the server) is a client bug → 422.
  const intent = parseRuntimeIntent(c.req.param('intent'));
  if (!intent) {
    return c.json(
      errorBody(
        `Unknown command intent: ${String(c.req.param('intent'))}`,
        'INVALID_COMMAND_INTENT'
      ),
      422
    );
  }

  // Optional body: trailing instructions after the intent token. An empty
  // POST has no body, so absence is valid.
  const parsedBody = CommandIntentBodySchema.safeParse(readJsonBody(c));
  if (!parsedBody.success) {
    return c.json(errorBody('Invalid request body', 'VALIDATION_ERROR'), 400);
  }
  const instructions = parsedBody.data?.instructions;

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
      return c.json(errorBody('Session not found', 'SESSION_NOT_FOUND'), 404);
    }
  }

  // Honest capability gate: an unsupported runtime is a 422 and the adapter's
  // executeCommandIntent is NEVER called (the composer keeps the text on the
  // client; this is the server half of that honesty).
  const caps = runtime.getCapabilities();
  if (!caps.commandIntents[intent].supported) {
    return c.json(
      errorBody(
        `${caps.type} does not support the ${intent} command intent`,
        'COMMAND_INTENT_UNSUPPORTED'
      ),
      422
    );
  }

  const clientId = c.req.header('x-client-id') || crypto.randomUUID();
  // The body carries no cwd (only optional instructions), so source it from
  // the session's live projector (set by the /events connect / prior turn).
  const cwd = peekProjector(sessionId)?.cwd ?? DEFAULT_CWD;

  logger.info('[POST /command-intents] trigger', {
    sessionId,
    intent,
    hasInstructions: instructions !== undefined,
  });

  // Persist completed runs (DOR-189), mirroring /messages so the
  // compact_boundary survives a restart.
  const projector = getOrCreateProjector(sessionId, cwd, {
    persist: persistenceModeFor(caps),
  });

  const result = await dispatchCommandIntent({
    sessionId,
    clientId,
    intent,
    cwd,
    instructions,
    projector,
    runtime,
    // A compaction is not new words: it carries what the chat's latest turn carried (DOR-3061).
    ...continuationCeiling(sessionId),
    onError: (err) => {
      logger.warn('[POST /command-intents] detached run error', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    },
  });

  if (!result.accepted) {
    // This asks the lock under the REQUEST's id, while the lock is keyed by the
    // canonical one — the mismatch that made `/ui-action` report a holder nobody
    // held (DOR-1239). Left as-is deliberately: `dispatchCommandIntent` answers
    // `{ accepted }` alone, so carrying the holder back would change its
    // signature, and a compact is never triggered by a click nobody can explain.
    const lockInfo = runtime.getLockInfo(sessionId);
    logger.warn('[POST /command-intents] session locked', {
      sessionId,
      lockedBy: lockInfo?.clientId ?? 'unknown',
    });
    return c.json(
      {
        error: 'Session locked',
        code: 'SESSION_LOCKED',
        lockedBy: lockInfo?.clientId ?? 'unknown',
        lockedAt: lockInfo ? new Date(lockInfo.acquiredAt).toISOString() : new Date().toISOString(),
      },
      409
    );
  }

  return c.json({ sessionId }, 202);
}
