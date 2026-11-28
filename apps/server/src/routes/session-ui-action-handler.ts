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
 * **A click is a wake, and never a late one** (spec `turns-survive-restarts`
 * §6.3, T7). The click is saved as one `wake_chat`, keyed by the `eventId` the
 * app minted for it (else one minted here per request), so a retried request
 * starts one turn and a restart before the turn starts loses nothing. A click
 * that lands while a turn is running waits for it to end, for a short while
 * (`WAKE_NOT_LATE_MS`, the bound it used to wait before it refused a busy
 * chat): a widget action run long after, against whatever a later turn left
 * behind, is not the action the person clicked, so past that it is dropped.
 *
 * @module routes/session-ui-action-handler
 */
import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { UiActionRequestSchema } from '@dorkos/shared/schemas';
import { formatUiActionMessage } from '@dorkos/shared/ui-widget';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody, validationProblem } from '@dorkos/http-kit';
import { honoRequestFacts } from '../http/request-facts.js';
import { isPersonTurn } from '../lib/caller-authority.js';
import { httpTurnOrigin } from '../services/session/origin/turn-origin.js';
import type { RequestFacts } from '../http/request-facts.js';
import { getDirectChats } from '../services/rooms/direct-chat/index.js';
import { personTurnBound } from './room-post-bound.js';
import { parseSessionId } from '../lib/route-utils.js';
import { invalidSessionId, sessionNotFound } from './session-route-replies.js';
import { DEFAULT_CWD } from '../lib/resolve-root.js';
import { logger } from '../lib/logger.js';
import { peekProjector } from '../services/session/index.js';
import { wakeChat } from '../services/runs/index.js';
import { WAKE_NOT_LATE_MS } from '@dorkos/shared/turn-port';

/** The ceiling a widget action's turn carries: see {@link personTurnBound}. */
function uiActionCeiling(
  facts: RequestFacts,
  sessionId: string
): { permissionCeiling?: 'runtime-default' } {
  const bound = personTurnBound(facts, getDirectChats()?.forSession(sessionId) != null);
  return bound ? { permissionCeiling: bound } : {};
}
/**
 * Handler for `POST /api/sessions/:id/ui-action`, mounted by `sessions.ts`; see
 * the module doc for semantics.
 *
 * @param c - The request context (`:id` route param + `UiActionRequest` body);
 *   answers 202 trigger / 400 / 404
 */
export async function sessionUiActionHandler(c: Context<ApiEnv>): Promise<Response> {
  const sessionId = parseSessionId(c.req.param('id'));
  if (!sessionId) return invalidSessionId(c);

  const parsed = UiActionRequestSchema.safeParse(readJsonBody(c));
  if (!parsed.success) {
    // The detail names the first issue (e.g. the serialized-payload size cap) —
    // every field feeds the injected turn prompt, so a clear reject beats a generic one.
    return validationProblem(c, parsed.error);
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
      return sessionNotFound(c);
    }
  }

  const facts = honoRequestFacts(c);
  const { cwd } = parsed.data;
  // One click, one turn: the app's id for the click, else one per request.
  const eventId = parsed.data.eventId ?? randomUUID();
  logger.info('[POST /ui-action] trigger', { sessionId, actionId: parsed.data.actionId, eventId });
  wakeChat({
    sourceKind: 'ui-action',
    eventId,
    start: {
      sessionId,
      ...(cwd !== undefined ? { cwd } : {}),
      content: formatUiActionMessage(parsed.data),
      origin: httpTurnOrigin(!isPersonTurn(facts)),
      tier: 'owner',
      // Not late: a widget action answers the turn it was rendered in (see the module doc).
      notAfter: Date.now() + WAKE_NOT_LATE_MS,
      // From Wi-Fi, the turn runs at the runtime's default at most (DOR-3037), and an unproven
      // action in a Direct chat's own session is held the same way (DOR-3088 G2).
      ...uiActionCeiling(facts, sessionId),
    },
  });
  // The id the runtime knows the chat by, as every trigger answers (DOR-1262).
  return c.json({ sessionId: runtime.getInternalSessionId(sessionId) ?? sessionId }, 202);
}
