/**
 * Answering a prompt a session's turn is waiting on: the six answer routes
 * (`approve`, `deny`, `batch-approve`, `batch-deny`, `submit-answers`,
 * `submit-elicitation`), who may answer, and who is named on the receipt
 * (DOR-2335). Split out of `routes/sessions.ts`, which mounts them under
 * `/api/sessions`.
 *
 * @module routes/session-answers
 */
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  ApprovalRequestSchema,
  BatchApprovalRequestSchema,
  SubmitAnswersRequestSchema,
  SubmitElicitationRequestSchema,
} from '@dorkos/shared/schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import {
  readCallerAuthority,
  requireOperatorCookieUnderLogin,
  type OperatorCookieRefusal,
} from '../lib/caller-authority.js';
import { logger } from '../lib/logger.js';
import { refuseStandingYesFromWifi } from '../services/core/auth/sessions/wifi-level.js';
import { errorBody, parseSessionId } from '../lib/route-utils.js';
import { resolveDecisionAuthority } from '../services/core/approvals/index.js';
import { getUserById, readOwnerAccount } from '../services/core/auth/index.js';
import { configManager } from '../services/core/config-manager.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { resolveAnswererName } from '../services/identity/operator-profile.js';

/**
 * What a caller is told when it tried to answer a prompt without being a person
 * signed in on this machine.
 *
 * Written for whoever ends up reading it, which is often an agent relaying it to
 * a person: it says WHERE the answer has to happen, not which header was
 * missing. A refusal that names a header reads as a hint about how to get around
 * it. The same reasoning, and nearly the same sentence, as the capability
 * approvals' `DECIDE_NEEDS_COCKPIT`.
 */
const ANSWERING_NEEDS_COCKPIT =
  'Answering an agent has to happen inside DorkOS, by a person who is signed in. ' +
  'A program holding an API key cannot answer for you. Open DorkOS and answer it there.';

/**
 * Refuse anything that is not a person in the cockpit answering for themselves.
 *
 * These six routes were protected by the session gate alone, which was defensible
 * while the only way to reach them was the session you were looking at.
 * Broadcasting the Ask to every route makes them reachable from everywhere, and
 * DOR-609's lesson is that _who acted_ is not _who may_.
 *
 * **Fail-closed and structural.** An agent that presents its identity header can
 * never answer ANY prompt, its own included, because `readCallerAuthority`
 * reports `agentIdentityPresented` for a header that did not even resolve — a
 * revoked token still means a machine is calling. There is therefore no id to
 * compare and no way to spoof one: "the requester never self-approves" is a
 * property of what the path accepts, not a check it runs.
 *
 * Under login-on, a caller holding a per-user API key is refused too. An agent
 * legitimately holds one of the person's keys — it is how a Codex or OpenCode
 * agent reaches the operator surface at all — which is exactly the residual
 * DOR-474 closed for capability approvals and this closes for tool prompts.
 *
 * With login off `requireOperatorCookieUnderLogin` allows, because there is no
 * cookie for anyone to present. That is the named, documented residual, and it
 * is identical to the one capability approvals carry: see
 * `lib/caller-authority.ts`.
 *
 * Composed from shipped pieces, with no new predicate, so "who counts as a
 * person" cannot mean one thing at an approval and another at a tool prompt.
 *
 * ## Its relationship to `askEntitlement`
 *
 * `services/session/asks/ask-entitlement.ts` is the shared statement of who may
 * answer, and every surface that SHOWS an Ask reads it. This guard is not
 * changed to call it and is not given a second gate: under one account an
 * entitlement check behind this bar could never fail, and a check that cannot
 * discriminate is worse than none. What holds the two together instead is
 * `services/session/asks/__tests__/ask-answer-conformance.test.ts`, which drives
 * the same callers through both and fails if they disagree — so the day a
 * second person exists, one of them cannot quietly widen.
 *
 * @param facts - The request's facts, with the session gate's resolved user.
 * @returns `undefined` when the caller may answer, or the refusal to answer with.
 */
function requirePersonToAnswer(facts: RequestFacts): OperatorCookieRefusal | undefined {
  const authority = resolveDecisionAuthority(readCallerAuthority(facts));
  if (!authority.allowed) {
    return { status: authority.status, code: authority.code, error: authority.error };
  }
  const notAPerson = requireOperatorCookieUnderLogin(facts, 'whether a tool runs');
  return notAPerson ? { ...notAPerson, error: ANSWERING_NEEDS_COCKPIT } : undefined;
}

/**
 * What to call whoever is answering, so the receipt in every OTHER window can
 * name them instead of saying only "Already answered at 2:01".
 *
 * Runs only after {@link requirePersonToAnswer} has already decided the caller
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
 * @param facts - The request's facts, with the session gate's resolved user.
 * @returns The answerer, as the `answeredBy` option the runtime takes: empty
 *   when no name is known or the lookup failed.
 */
function answeredBy(facts: RequestFacts): { answeredBy?: string } {
  const { user } = facts;
  try {
    const name = resolveAnswererName({
      // Read with its email either way, so a name that is only the email is
      // ignored rather than printed (DOR-2964).
      account: () => {
        const id = user?.userId ?? readOwnerAccount()?.id;
        return id ? getUserById(id) : null;
      },
      configDisplayName: () => configManager.get('profile')?.displayName ?? null,
    });
    return name ? { answeredBy: name } : {};
  } catch (err) {
    // Two disk reads for a cosmetic label sit inside the path that decides
    // whether a tool runs. A locked database or an unreadable config must cost
    // the receipt its name, never the person their answer, so the throw is
    // swallowed here rather than 500ing an approve.
    logger.warn('[POST /answer] could not resolve who is answering; the receipt goes unnamed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

/** What an answer route has read, once the caller may answer and the session id parses. */
interface Answering {
  sessionId: string;
  facts: RequestFacts;
}

/**
 * Run the answer bar, then read the session id: the order every answer route
 * has always refused in.
 *
 * @returns What the route reads, or the refusal to return.
 */
function startAnswer(c: Context<ApiEnv>): Answering | Response {
  const facts = honoRequestFacts(c);
  const refusal = requirePersonToAnswer(facts);
  if (refusal) {
    return c.json(
      { error: refusal.error, code: refusal.code },
      refusal.status as ContentfulStatusCode
    );
  }
  const sessionId = parseSessionId(c.req.param('id'));
  if (!sessionId) return c.json(errorBody('Invalid session ID', 'INVALID_SESSION_ID'), 400);
  return { sessionId, facts };
}

const INVALID_REQUEST = errorBody('Invalid request', 'VALIDATION_ERROR');
const ALREADY_RESOLVED = errorBody('Interaction already resolved', 'INTERACTION_ALREADY_RESOLVED');

/**
 * The six answer routes, each behind {@link requirePersonToAnswer}, and behind
 * the session read guard `routes/sessions.ts` puts in front of every path under
 * `/:id` before it mounts these: the Ask is reachable from every route in the
 * cockpit, so who may answer it is a property of the endpoint rather than of
 * where the card happened to be drawn.
 *
 * @returns The routes, for `routes/sessions.ts` to mount at its root.
 */
export function createSessionAnswerRoutes(): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  // POST /api/sessions/:id/approve - Approve pending tool call
  router.post('/:id/approve', async (c) => {
    const answering = startAnswer(c);
    if (answering instanceof Response) return answering;
    const { sessionId, facts } = answering;
    const parsed = ApprovalRequestSchema.safeParse(readJsonBody(c));
    if (!parsed.success) return c.json(INVALID_REQUEST, 400);
    const { toolCallId, alwaysAllow } = parsed.data;
    const standing = refuseStandingYesFromWifi(facts, alwaysAllow === true);
    if (standing) return c.json(standing, 403);
    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    const approved = runtime.approveTool(sessionId, toolCallId, true, {
      alwaysAllow,
      ...answeredBy(facts),
    });
    if (!approved) {
      if (runtime.hasSession(sessionId)) return c.json(ALREADY_RESOLVED, 409);
      return c.json(errorBody('No pending approval', 'NO_PENDING_APPROVAL'), 404);
    }
    return c.json({ ok: true });
  });

  // POST /api/sessions/:id/deny - Deny pending tool call
  //
  // Guarded for the same reason as approve, not as a symmetry: an agent that can
  // deny can suppress a person's decision and bury the card that would have told
  // them. Same argument the capability approvals' deny route makes.
  router.post('/:id/deny', async (c) => {
    const answering = startAnswer(c);
    if (answering instanceof Response) return answering;
    const { sessionId, facts } = answering;
    const parsed = ApprovalRequestSchema.safeParse(readJsonBody(c));
    if (!parsed.success) return c.json(INVALID_REQUEST, 400);
    const { toolCallId, reason } = parsed.data;
    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    // A blank field is not a reason. Normalising here keeps every runtime and the
    // receipt copy from having to re-decide what an empty string means.
    const denyReason = reason?.trim() ? reason.trim() : undefined;
    const denied = runtime.approveTool(sessionId, toolCallId, false, {
      denyReason,
      ...answeredBy(facts),
    });
    if (!denied) {
      if (runtime.hasSession(sessionId)) return c.json(ALREADY_RESOLVED, 409);
      return c.json(errorBody('No pending approval', 'NO_PENDING_APPROVAL'), 404);
    }
    return c.json({ ok: true });
  });

  // POST /api/sessions/:id/batch-approve - Approve multiple pending tool calls
  //
  // POST /api/sessions/:id/batch-deny - Deny multiple pending tool calls. Carries
  // no reason, and the UI offers no field for one: "Deny all" answers a stack of
  // unrelated asks at once, so a single sentence would be attached to requests it
  // was never about. Each refusal therefore reports honestly that nobody
  // explained it, and the transcript receipts say so.
  for (const [path, approved] of [
    ['/:id/batch-approve', true],
    ['/:id/batch-deny', false],
  ] as const) {
    router.post(path, async (c) => {
      const answering = startAnswer(c);
      if (answering instanceof Response) return answering;
      const { sessionId, facts } = answering;
      const parsed = BatchApprovalRequestSchema.safeParse(readJsonBody(c));
      if (!parsed.success) return c.json(INVALID_REQUEST, 400);
      const runtime = await runtimeRegistry.resolveForSession(sessionId);
      const answerer = answeredBy(facts);
      const results = parsed.data.toolCallIds.map((id) => ({
        toolCallId: id,
        ok: runtime.approveTool(sessionId, id, approved, { ...answerer }),
      }));
      return c.json({ results });
    });
  }

  // POST /api/sessions/:id/submit-answers - Submit answers for AskUserQuestion.
  // A question is answered by a person too. The three kinds of prompt share one
  // bar, because they are one object to whoever is being asked.
  router.post('/:id/submit-answers', async (c) => {
    const answering = startAnswer(c);
    if (answering instanceof Response) return answering;
    const { sessionId, facts } = answering;
    const parsed = SubmitAnswersRequestSchema.safeParse(readJsonBody(c));
    if (!parsed.success) return c.json(INVALID_REQUEST, 400);
    const { toolCallId, answers } = parsed.data;
    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    const ok = runtime.submitAnswers(sessionId, toolCallId, answers, answeredBy(facts));
    if (!ok) {
      if (runtime.hasSession(sessionId)) return c.json(ALREADY_RESOLVED, 409);
      return c.json(errorBody('No pending question', 'NO_PENDING_QUESTION'), 404);
    }
    return c.json({ ok: true });
  });

  // POST /api/sessions/:id/submit-elicitation - Submit response to MCP elicitation
  router.post('/:id/submit-elicitation', async (c) => {
    const answering = startAnswer(c);
    if (answering instanceof Response) return answering;
    const { sessionId, facts } = answering;
    const parsed = SubmitElicitationRequestSchema.safeParse(readJsonBody(c));
    if (!parsed.success) return c.json(INVALID_REQUEST, 400);
    const { interactionId, action, content } = parsed.data;
    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    const ok = runtime.submitElicitation(
      sessionId,
      interactionId,
      action,
      content,
      answeredBy(facts)
    );
    if (!ok) {
      if (runtime.hasSession(sessionId)) return c.json(ALREADY_RESOLVED, 409);
      return c.json(errorBody('No pending elicitation', 'NO_PENDING_ELICITATION'), 404);
    }
    return c.json({ ok: true });
  });

  return router;
}
