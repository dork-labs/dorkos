/**
 * The HTTP half of "your activity first" (spec `your-activity-first` D3, D4,
 * D6): recording that you opened or wrote in a chat, and keeping every chat
 * you touched in `GET /api/sessions/recent`.
 *
 * All three routes that touch `session_touches` go through here, so they ask
 * one question — {@link isPersonAtTheApp} — and save under the same id. They
 * live here rather than in `routes/sessions.ts` to keep that file under the
 * size rule, mirroring `session-queue-handler.ts`.
 *
 * @module routes/session-touch-handler
 */
import type { Context } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import { isPersonAtTheApp } from '../lib/caller-authority.js';
import { logger } from '../lib/logger.js';
import { errorBody, parseSessionId } from '../lib/route-utils.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { getSessionTouchStore, laterIso } from '../services/session/origin/session-touch-store.js';
import type { ResolveTouches } from '../services/session/origin/touched-by-you-overlay.js';

/**
 * `POST /api/sessions/:id/opened` — the chat page is showing this chat (D3).
 *
 * Recorded only for a person at the app (D4); any other caller gets the same
 * 204 and nothing changes, so the answer tells a script nothing about the
 * rule. Takes no body, and nothing here reads one.
 *
 * Saved under the chat's current id, exactly as `GET /:id` reads it: a link or
 * a tab can still hold an id the runtime has since retired, and a row under
 * that id is one no session list would ever match.
 *
 * @param c - The request context; `:id` is the chat
 */
export async function sessionOpenedHandler(c: Context<ApiEnv>): Promise<Response> {
  const sessionId = parseSessionId(c.req.param('id'));
  if (!sessionId) return c.json(errorBody('Invalid session ID', 'INVALID_SESSION_ID'), 400);
  if (isPersonAtTheApp(honoRequestFacts(c))) {
    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    const currentId = runtime.getInternalSessionId(sessionId) ?? sessionId;
    getSessionTouchStore()?.recordOpened(currentId, new Date().toISOString());
  }
  return c.body(null, 204);
}

/**
 * Record that you wrote in a chat, after `POST /:id/messages` accepted the
 * message (D4). Never on a refusal, and never for an agent or a script.
 *
 * It runs after the dispatch, so a store failure is logged and swallowed: the
 * message is already on its way, the 202 must still say so, and the cost is
 * only where the chat sorts.
 *
 * @param facts - The messages request's facts, for the caller's identity.
 * @param chatId - The chat's canonical id, as the dispatcher answered it.
 */
export function recordWroteIfPerson(facts: RequestFacts, chatId: string): void {
  if (!isPersonAtTheApp(facts)) return;
  try {
    getSessionTouchStore()?.recordWrote(chatId, new Date().toISOString());
  } catch (err) {
    logger.warn('[sessions] could not record that you wrote in a session', {
      sessionId: chatId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The `/recent` keeper for `touchedSince` (D6): the ids of merged sessions
 * you touched at or after that time, read from `session_touches` in one batch.
 * Compared by instant, because the caller's time may carry an offset.
 *
 * @param touchedSince - ISO-8601 time from the query.
 * @param resolveTouches - The batched lookup; absent means nothing is kept.
 */
export function touchedSinceKeeper(
  touchedSince: string,
  resolveTouches: ResolveTouches | undefined
): (merged: readonly { id: string }[]) => ReadonlySet<string> {
  const since = Date.parse(touchedSince);
  return (merged) => {
    const kept = new Set<string>();
    if (!resolveTouches || merged.length === 0) return kept;
    for (const [id, touch] of resolveTouches(merged.map((s) => s.id))) {
      const touchedAt = laterIso(touch.openedAt, touch.wroteAt);
      if (touchedAt && Date.parse(touchedAt) >= since) kept.add(id);
    }
    return kept;
  };
}
