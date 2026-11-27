/** Mount the ordinary session message entry at its existing route position. */
import type { Hono } from 'hono';
import { SendMessageRequestSchema } from '@dorkos/shared/schemas';
import { CREDITS_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { askForPersonBeforeChat } from '../http/person-session-refusal.js';
import { readJsonBody, sendProblem, validationProblem } from '@dorkos/http-kit';
import { parseSessionId } from '../lib/route-utils.js';
import {
  dispatchSessionMessage,
  isSessionLaunchRefusal,
} from '../services/session/launch/launch-session.js';
import type { SessionLocationStore } from '../services/core/runtime-seam/session-location-store.js';
import { sessionExists } from '../services/session/launch/session-exists.js';
import { registeredSpellingOf } from '../services/session/launch/verify-chat-agent.js';
import { httpTurnOrigin } from '../services/session/origin/turn-origin.js';
import { httpLaunchOf } from './session-launcher.js';
import { sessionMessageReceipt } from './session-message-receipt.js';
import { recordAccepted } from './session-message-accepted.js';
import {
  isPersonChatWriteRefusal,
  observePersonChat,
  preparePersonChat,
  personChatMissing,
} from './session-person-birth.js';
import {
  invalidSessionId,
  launchRefusalReply,
  ownerRefusalReply,
  sessionNotFound,
} from './session-route-replies.js';
import { workspaceCallerOf } from './session-workspace-caller.js';
import type { SessionRouteDeps } from './sessions.js';
import { errorRefusalUnlessOwner } from './cloud-owner-bar.js';

/** What naming DorkOS credits for a new session says to a caller that is not the owner. */
const RUN_ON_CREDITS = {
  personOnly: 'Only you can run a chat on your DorkOS credits, from the DorkOS app.',
  action: 'run a chat on DorkOS credits',
};

/**
 * Register the first and subsequent message route at its existing mount position.
 *
 * @param router - The session router after its per-session guard.
 * @param deps - The session's live placement and registration lookups.
 * @param personBirth - The saved folders and person allocations, when mounted.
 */
export function mountSessionSendMessage(
  router: Hono<ApiEnv>,
  deps: Pick<SessionRouteDeps, 'personBirth' | 'meshCore' | 'roomSessionPlace'>,
  personBirth?: SessionLocationStore
): void {
  // POST /api/sessions/:id/messages — Accept a message (trigger-only, ADR-0264;
  // accept-only, spec `persistent-session-runtime` §3.3).
  //
  // This endpoint NO LONGER streams tokens in-band, and no longer waits for the
  // session to be free. It validates and hands the message to the dispatcher,
  // which either starts the turn now or puts it on the session's durable queue,
  // then answers `202 Accepted` with the canonical session id, the message id, the
  // delivery outcome and the queue position. Everything after that — the turn
  // starting, its tokens, its end — arrives on `GET /:id/events`, the single
  // delivery path.
  //
  // **There is no `409` here.** A busy session used to refuse a second window;
  // now it queues, and the person can edit or remove what is waiting through the
  // queue routes below. The write-lock still exists — it is the mutex one turn
  // window holds, and its inactivity TTL still reclaims a turn that went dark
  // (DOR-782) — but it is no longer an answer this route can give. The lock is
  // bound to the turn's real duration and released on completion AND on error; a
  // detached failure is surfaced INTO the projector so `/events` consumers see it.
  // See `services/session/message-dispatcher.ts` and `trigger-turn.ts` for the
  // orchestration and the lock/error invariants, and
  // `services/session/launch/launch-session.ts` for the binding this route shares
  // with every other surface that starts a session from a message.
  router.post('/:id/messages', askForPersonBeforeChat(), async (c) => {
    const sessionId = parseSessionId(c.req.param('id'));
    if (!sessionId) return invalidSessionId(c);

    const parsed = SendMessageRequestSchema.safeParse(readJsonBody(c));
    if (!parsed.success) return validationProblem(c, parsed.error);

    // Naming DorkOS credits for a new session spends the DorkOS account's money,
    // so only the owner of this DorkOS may name it (DOR-2652). Any other
    // account, or none, is the runtime's own business and stays open.
    if (parsed.data.account === CREDITS_ACCOUNT_ID) {
      const refusal = errorRefusalUnlessOwner(honoRequestFacts(c), RUN_ON_CREDITS);
      if (refusal) return ownerRefusalReply(c, refusal);
    }

    const store = personBirth ?? deps.personBirth;
    const source = store && observePersonChat(store, sessionId);
    // An id nobody started is a 404, never a new session (DOR-2712): a stale id
    // used to start a stranger session on the default runtime in the default
    // folder. Starting a chat is said out loud with `create: true`.
    if (parsed.data.create !== true && !(await sessionExists(sessionId, parsed.data.cwd))) {
      return sessionNotFound(c, 'No session has this id. To start a new one, send create: true.');
    }

    // Read X-Client-Id header, or generate UUID if missing
    const clientId = c.req.header('x-client-id') || crypto.randomUUID();

    // `{ kind: 'interactive' }` is what unlocks the trust stop, and this route is
    // where that claim is true: a message posted to `/api/sessions/:id/messages`
    // came from a person at a control panel holding the session's event stream
    // open. Rooms, tasks and bindings never pass through here, and each names
    // itself at its own call (DOR-2105). A caller presenting an agent identity
    // is not that person: its chat is agent work, so it can read what it
    // started (spec `audit-trail` §3.4), and it seeds no operator stop. Nor is
    // a caller with no agent header but no session of the person's, once an
    // owner exists who could prove themselves (DOR-3330): its message runs as
    // agent work, never as the person.
    // Whoever is not the person may only run a chat where they could start one
    // themselves (DOR-3644), and an agent's launch carries its own marks on.
    // From Wi-Fi, the turn runs at the runtime's default at most (DOR-3037).
    const facts = honoRequestFacts(c);
    const launch = httpLaunchOf(facts, sessionId);
    if (source && launch.launcher.kind !== 'person') return sendProblem(c, personChatMissing.body);
    const prepared =
      store && source
        ? await preparePersonChat(store, sessionId, facts, source, deps.meshCore, parsed.data.cwd)
        : undefined;
    if (prepared && 'refusal' in prepared) return sendProblem(c, prepared.refusal.body);
    // The acknowledged agent, named in any spelling of its folder (DOR-5117).
    if (
      prepared?.registeredAgentPath !== undefined &&
      parsed.data.agentPath !== undefined &&
      registeredSpellingOf(parsed.data.agentPath, [prepared.registeredAgentPath]) === undefined
    )
      return sendProblem(c, personChatMissing.body);
    const request = prepared
      ? {
          ...parsed.data,
          ...(prepared.cwd !== undefined && { cwd: prepared.cwd }),
          ...(prepared.registeredAgentPath !== undefined && {
            agentPath: prepared.registeredAgentPath,
          }),
        }
      : parsed.data;
    const result = await dispatchSessionMessage({
      origin: httpTurnOrigin(launch.launcher.kind !== 'person'),
      ...launch,
      sessionId,
      request,
      ...(prepared ? { personChatSource: prepared.binding } : {}),
      clientId,
      meshCore: deps.meshCore,
      roomSessionPlace: deps.roomSessionPlace,
      // Who is asking, for a new workspace a workspaceKey names (DOR-2335).
      workspaceCaller: workspaceCallerOf(facts),
    }).catch((error: unknown) => {
      if (prepared && isPersonChatWriteRefusal(error)) return null;
      throw error;
    });
    if (!result) return sendProblem(c, personChatMissing.body);
    if (isSessionLaunchRefusal(result)) return launchRefusalReply(c, result);

    // Accepted, so it counts as you writing here (spec `your-activity-first`
    // D4). A dispatch that answered `accepted: false` refused the message and
    // records nothing. An accepted one names the chat's canonical id; the
    // fallback only covers the type, which leaves the field optional. Signing
    // the sending device out stops the chat (DOR-3172).
    if (result.accepted) recordAccepted(honoRequestFacts(c), result, sessionId, clientId);

    return c.json(sessionMessageReceipt(result), 202);
  });
}
