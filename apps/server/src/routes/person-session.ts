/**
 * `POST /api/person-session`: the owner's one password step-up at this
 * computer (DOR-3330, `services/core/auth/person-step-up.ts`).
 *
 * Once an owner exists, what only the person may do needs their browser
 * session, and the app at this computer may carry none while it asks for no
 * password. A person-only action then answers `401 person_session_required`;
 * the app asks the owner's password once and posts it here. A match leaves a
 * long-lived session that works only at this computer, and answers with the
 * person proof the app keeps beside it (`person-proof.ts`), so it never asks
 * again there until that session ends.
 *
 * Only a request from this computer, from no other site's page, naming no
 * agent and carrying no key, may ask. The password is the proof: an agent at
 * this computer can reach this route but does not have it, and wrong ones are
 * throttled for every caller at once (`owner-password.ts`).
 *
 * @module routes/person-session
 */
import { Hono, type Context } from 'hono';

import {
  PersonSessionRequestSchema,
  type PersonSessionRefusalCode,
  type PersonSessionResponse,
} from '@dorkos/shared/person-session';

import type { ApiEnv } from '../http/api-chain.js';
import { problem, readJsonBody } from '@dorkos/http-kit';
import { honoRequestFacts } from '../http/request-facts.js';
import { logger } from '../lib/logger.js';
import { classifyRequest, type RequestClass } from '../lib/request-classifier.js';
import { currentServerRole } from '../lib/server-role.js';
import { resolveTrustedOrigins } from '../lib/trusted-origins.js';
import { presentsAgentIdentity } from '../lib/http/agent-identity-header.js';
import { APPROVAL_TOKEN_HEADER } from '../services/core/capabilities/index.js';
import { getAuth, readOwnerAccount, type Auth } from '../services/core/auth/index.js';
import {
  checkOwnerPassword,
  ownerPasswordRetryAfterMs,
  type OwnerPasswordCheck,
} from '../services/core/auth/owner-password.js';
import { personProofFor } from '../services/core/auth/person-proof.js';
import { withRegistrationCaller } from '../services/core/auth/registration-policy.js';

/** What `Sec-Fetch-Site` may say: the app's own page, or no page at all. */
const OWN_PAGE_OR_NONE = new Set(['same-origin', 'none']);

/** What the routes read, injectable for tests. */
export interface PersonSessionDeps {
  /** Better Auth, or `undefined` before it is initialized. */
  auth: () => Auth | undefined;
  /** The install owner's id, or `null`. */
  ownerId: () => string | null;
  /** The password step-up. */
  checkPassword: (password: string | undefined) => Promise<OwnerPasswordCheck>;
  /** The server's trusted browser origins. */
  trustedOrigins: () => readonly string[];
}

const liveDeps: PersonSessionDeps = {
  auth: () => getAuth(),
  ownerId: () => readOwnerAccount()?.id ?? null,
  checkPassword: (password) => checkOwnerPassword(password),
  trustedOrigins: () => resolveTrustedOrigins(),
};

/** The answer for each way the password check can fail. */
const PASSWORD_REFUSALS: Record<
  Exclude<OwnerPasswordCheck, 'ok'>,
  { code: PersonSessionRefusalCode; detail: string }
> = {
  required: { code: 'invalid_request', detail: 'Enter your password.' },
  wrong: { code: 'wrong_password', detail: 'That’s not your DorkOS password. Try again.' },
  'too-many-attempts': {
    code: 'rate_limited',
    detail: 'Too many wrong passwords. Try again in a few minutes.',
  },
  'no-owner': { code: 'no_owner', detail: 'Create an owner account first.' },
  'no-password': { code: 'no_password', detail: 'Set a password for this computer’s owner first.' },
};

/** The answer when there is no owner to sign in as. */
function noOwner(c: Context<ApiEnv>): Response {
  return problem(c, 'no_owner', { detail: PASSWORD_REFUSALS['no-owner'].detail });
}

/**
 * The caller's class, when it may ask for a step-up at all, or the refusal.
 *
 * @param c - The request.
 * @param deps - The trusted origins.
 */
function callerOrRefusal(
  c: Context<ApiEnv>,
  deps: PersonSessionDeps
): { requestClass: RequestClass } | Response {
  const facts = honoRequestFacts(c);
  const requestClass = classifyRequest(facts, currentServerRole());
  if (requestClass.kind !== 'this-computer') {
    return problem(c, 'operator_only', { detail: 'Do this on the computer DorkOS runs on.' });
  }
  const origin = facts.headers.origin;
  const site = facts.headers['sec-fetch-site'];
  const program =
    presentsAgentIdentity(facts) ||
    facts.headers[APPROVAL_TOKEN_HEADER] !== undefined ||
    facts.headers.authorization !== undefined;
  const otherPage =
    (origin !== undefined && !deps.trustedOrigins().includes(origin)) ||
    (site !== undefined && !OWN_PAGE_OR_NONE.has(String(site)));
  if (program || otherPage) {
    return problem(c, 'person_only', { detail: 'Only you can do this, in the DorkOS app.' });
  }
  return { requestClass };
}

/**
 * Build the routes mounted at `/api/person-session`.
 *
 * @param deps - Seams for tests; the live auth, owner and password check by default.
 */
export function createPersonSessionRoutes(deps: PersonSessionDeps = liveDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  router.post('/', async (c) => {
    const caller = callerOrRefusal(c, deps);
    if (caller instanceof Response) return caller;
    const parsed = PersonSessionRequestSchema.safeParse(readJsonBody(c));
    const check = await deps.checkPassword(parsed.success ? parsed.data.password : undefined);
    if (check !== 'ok') {
      const { code, detail } = PASSWORD_REFUSALS[check];
      // When it is checked again, so the app can count down rather than guess.
      // `retryAfterMs` also sets the `Retry-After` header.
      const retryAfterMs = check === 'too-many-attempts' ? ownerPasswordRetryAfterMs() : undefined;
      return problem(c, code, { detail, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
    }
    const ownerId = deps.ownerId();
    const auth = deps.auth();
    if (!ownerId || !auth) return noOwner(c);
    // Inside the request's class, so the session is stamped `local` and
    // works only at this computer (`session-route.ts`).
    const { headers, response } = await withRegistrationCaller(caller.requestClass, () =>
      auth.api.signInOwnerAfterStepUp({ body: { userId: ownerId }, returnHeaders: true })
    );
    const proof = await personProofFor(response.sessionId);
    if (!proof) return noOwner(c);
    for (const cookie of headers.getSetCookie()) c.header('Set-Cookie', cookie, { append: true });
    logger.info('[Auth] The owner confirmed it was them at this computer');
    const answer: PersonSessionResponse = { ok: true, proof };
    return c.json(answer);
  });

  return router;
}
