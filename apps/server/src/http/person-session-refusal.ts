/**
 * One answer for a person-only write the person could make with their
 * session: `401 person_session_required` (DOR-3330).
 *
 * Every person-only bar refuses a caller at this computer that holds no
 * session once an owner exists, each in its own words and code. The app needs
 * one signal to ask the owner's password once and retry, so after the route
 * answers, a `401` or `403` to a write becomes this one when a person bar
 * marked the request as refused for want of the session
 * ({@link personSessionWasMissing}) and the caller is exactly that person
 * ({@link isPersonWithoutSession}). A refusal for any other reason keeps its
 * own words, and so do reads and the step-up route itself.
 *
 * @module http/person-session-refusal
 */
import type { Context, MiddlewareHandler } from 'hono';

import {
  PERSON_APP_HEADER,
  PERSON_SESSION_PATH,
  PERSON_SESSION_REQUIRED_CODE,
} from '@dorkos/shared/person-session';

import {
  isPersonWithoutSession,
  notePersonSessionMissing,
  PERSON_SESSION_REQUIRED_MESSAGE,
  personSessionWasMissing,
} from '../lib/person-without-session.js';
import { clearsTheAgentBar } from '../lib/caller-authority.js';
import { errorBody } from '../lib/route-utils.js';
import type { ApiEnv } from './api-chain.js';
import { readJsonBody } from './request-body.js';
import { honoRequestFacts, type RequestFacts } from './request-facts.js';

/**
 * Whether a call came from a window of the app, which can answer the step-up:
 * its own API calls carry the app marker, and its chat calls a client id. A
 * program without either hears the route's own refusal instead.
 */
function fromTheApp(facts: RequestFacts): boolean {
  return facts.headers[PERSON_APP_HEADER] !== undefined || !!facts.headers['x-client-id'];
}

/** Whether a method only reads. */
function readsOnly(method: string): boolean {
  return ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

/**
 * The chain step. Mounted after the session gate and agent identity, so it
 * sees what they proved.
 */
export function personSessionRefusal(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    await next();
    const status = c.res.status;
    if (status !== 401 && status !== 403) return;
    if (readsOnly(c.req.method) || c.req.path === PERSON_SESSION_PATH) return;
    // A response the route already wrote itself (a stream, the extension
    // bridge) is the client's now.
    if (c.env.outgoing.headersSent) return;
    const facts = honoRequestFacts(c);
    if (!fromTheApp(facts) || !personSessionWasMissing(facts)) return;
    if (!isPersonWithoutSession(facts)) return;
    c.res = c.json(errorBody(PERSON_SESSION_REQUIRED_MESSAGE, PERSON_SESSION_REQUIRED_CODE), 401);
  };
}

/**
 * Before a chat message from the app at this computer, ask for the owner's
 * step-up when no session proves the person yet (DOR-3330).
 *
 * Without the person's session a message runs as agent work, and agent work
 * is readable by every agent, which the owner's own chat must never be. So
 * the app window (its `X-Client-Id`) is asked once, and its message goes
 * after. A program with no window marker still runs, as agent work.
 */
export function askForPersonBeforeChat(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const facts = honoRequestFacts(c);
    if (facts.headers['x-client-id'] && isPersonWithoutSession(facts))
      return stepUpAnswer(c, facts);
    await next();
  };
}

/** The step-up answer, for a caller that is the person missing only their session. */
function stepUpAnswer(c: Context<ApiEnv>, facts: RequestFacts): Response {
  notePersonSessionMissing(facts);
  return c.json(errorBody(PERSON_SESSION_REQUIRED_MESSAGE, PERSON_SESSION_REQUIRED_CODE), 401);
}

/**
 * Before a scheduled task is made, changed, run or removed, ask the person
 * at this computer for the step-up when no session proves them (DOR-3330).
 * Anything else goes on to the route, which proposes an agent's task for
 * approval rather than arming it.
 */
export function askForPersonBeforeTaskWrite(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const facts = honoRequestFacts(c);
    if (!readsOnly(c.req.method) && fromTheApp(facts) && isPersonWithoutSession(facts)) {
      return stepUpAnswer(c, facts);
    }
    await next();
  };
}

/**
 * Only the person changes how much a chat may do (DOR-3330): a `PATCH` that
 * sets a chat's permission mode needs them, and nothing else.
 */
export function personOnlyModeChange(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const body = readJsonBody(c) as { permissionMode?: unknown } | undefined;
    const facts = honoRequestFacts(c);
    if (body?.permissionMode !== undefined && !clearsTheAgentBar(facts)) {
      if (fromTheApp(facts) && isPersonWithoutSession(facts)) return stepUpAnswer(c, facts);
      return c.json(
        errorBody('Only you can change what this chat may do.', 'person_required'),
        403
      );
    }
    await next();
  };
}
