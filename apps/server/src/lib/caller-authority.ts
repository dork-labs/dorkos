/**
 * Read, from one Express request, exactly the facts that decide whether a caller
 * is a person acting for themselves (spec `agent-trust` §3.3, DOR-467).
 *
 * There is one predicate for that question — `resolveDecisionAuthority` — and
 * three surfaces that need it: the endpoint that DECIDES an approval
 * (`routes/approvals.ts`), and the two mutation routes that must act without one
 * when the caller is a person (`routes/marketplace.ts`, `routes/config.ts`).
 *
 * They share this reader rather than each pulling headers off a request, because
 * the failure that matters here is not a wrong answer but a DIVERGENT one: if the
 * decide endpoint and the act-without-approval path disagree about what counts as
 * a person, one of them is wrong and nothing says which. Keeping the read in one
 * place is what lets the guarantee be stated as a single sentence — whoever may
 * decide an approval may act without one — and stay true.
 *
 * ## The second, stricter bar
 *
 * Clearing `resolveDecisionAuthority` is not always enough. Under the default
 * `local-trust` posture that resolver allows any caller presenting neither an
 * agent header nor an approval token, which an agent with a shell reaches by
 * omitting two headers. For most effects that is an accepted trade (the cockpit
 * needs those routes and `local-trust` genuinely cannot tell it apart from
 * anything else on loopback). For a few it is not, because the effect is a
 * standing one: a permission that keeps saying yes for hours.
 *
 * {@link requireOperatorCookie} is that stricter bar, and it lives here for the
 * same anti-divergence reason as the reader above — two routes enforce it and
 * they must not mean different things by it.
 *
 * @module lib/caller-authority
 */
import type { Request, Response } from 'express';

import type {
  DecisionAuthorityRequest,
  LoginEnabledLookup,
} from '../services/core/approvals/index.js';
import { APPROVAL_TOKEN_HEADER } from '../services/core/capabilities/index.js';
import { AGENT_IDENTITY_HEADER, getRequestAgentIdentity } from '../middleware/agent-identity.js';
import type { RequestUser } from '../services/core/auth/session-gate.js';
import { configManager } from '../services/core/config-manager.js';

/**
 * Build the {@link DecisionAuthorityRequest} for an incoming request.
 *
 * An agent counts as present if EITHER the middleware resolved one or the raw
 * `X-DorkOS-Agent` header is there at all: a header that did not resolve (a
 * revoked or expired agent) still means a machine is calling, and a person in the
 * cockpit never sends it.
 *
 * @param req - The incoming request.
 * @param res - The response carrying `sessionGate`'s resolved user.
 * @returns What the caller presented, for `resolveDecisionAuthority`.
 */
export function readCallerAuthority(req: Request, res: Response): DecisionAuthorityRequest {
  const user = res.locals.user as RequestUser | undefined;
  return {
    agentIdentityPresented:
      getRequestAgentIdentity(res) !== undefined ||
      req.headers[AGENT_IDENTITY_HEADER] !== undefined,
    approvalTokenPresented: req.headers[APPROVAL_TOKEN_HEADER] !== undefined,
    ...(user ? { user } : {}),
  };
}

/**
 * Refusal code when login is off, so no caller can present a session cookie and
 * standing permissions cannot exist at all.
 */
export const STANDING_GRANTS_REQUIRE_LOGIN_CODE = 'standing_grants_require_login';

/**
 * Refusal code when login is on but this caller proved itself with something
 * other than a browser session — today, a per-user API key.
 */
export const OPERATOR_COOKIE_REQUIRED_CODE = 'operator_cookie_required';

/** A refused write, in the shape the routes answer with. */
export interface OperatorCookieRefusal {
  /** HTTP status to answer with. */
  status: number;
  /** Machine-readable refusal code. */
  code: string;
  /** One plain sentence explaining the refusal. */
  error: string;
}

/**
 * Read `auth.enabled` from the live user config, exactly as `sessionGate` does.
 *
 * No defensive branch for an unreadable config: `configManager` is a module
 * singleton that boot initializes long before any router mounts, and a genuine
 * read failure THROWS rather than returning something falsy. The throw
 * propagates, the request never reaches the write, and the effect is the same
 * refusal a false would have produced. Writing a `return true` fallback here
 * would look like it was making that guarantee when it is the throw that does.
 */
function loginEnabledFromConfig(): boolean {
  return configManager.get('auth')?.enabled === true;
}

/**
 * Require that this request came from a person signed in to the cockpit, proved
 * by a session cookie.
 *
 * ## Why a cookie, and not something weaker
 *
 * The chain this closes was reproduced, not reasoned: patch the setting on with
 * the agent header omitted, ask for the destructive capability WITH an identity
 * so the approval records an agent path, then grant it standing with every header
 * stripped. Each step clears `resolveDecisionAuthority` under `local-trust`,
 * because omitting two headers is all that resolver asks for. A cookie is the one
 * signal that separates the cockpit from a header-stripping caller on loopback,
 * and inventing a weaker marker would assert a distinction DorkOS cannot make.
 *
 * The consequence is stated rather than hidden: with login off there is no
 * cookie, so standing permissions do not exist in that posture. That is more
 * honest than a control that appears to tell callers apart when it cannot.
 *
 * This is a SERVER-side guarantee. The cockpit also hides and disables the
 * controls this refuses, but that is a courtesy; this is the guarantee.
 *
 * @param res - The response carrying `sessionGate`'s resolved user.
 * @param isLoginEnabled - Optional login-state lookup for tests.
 * @returns `undefined` when the caller presented a session cookie, or the refusal
 *   to answer with.
 */
export function requireOperatorCookie(
  res: Response,
  isLoginEnabled?: LoginEnabledLookup
): OperatorCookieRefusal | undefined {
  if (!(isLoginEnabled ?? loginEnabledFromConfig)()) {
    return {
      status: 403,
      code: STANDING_GRANTS_REQUIRE_LOGIN_CODE,
      error:
        'Standing permissions need Require login turned on, because without it DorkOS cannot tell you apart from an agent running on this machine',
    };
  }

  const user = res.locals.user as RequestUser | undefined;
  if (user?.credential === 'cookie') return undefined;

  return {
    status: 403,
    code: OPERATOR_COOKIE_REQUIRED_CODE,
    error: 'Only a person signed in to DorkOS can change standing permissions',
  };
}
