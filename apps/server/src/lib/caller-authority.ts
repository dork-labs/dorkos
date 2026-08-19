/**
 * Read, from one Express request, exactly the facts that decide whether a caller
 * is a person acting for themselves (spec `agent-trust` §3.3, DOR-467).
 *
 * There is one predicate for that question — `resolveDecisionAuthority` — and two
 * kinds of surface that need it: the endpoints that DECIDE an approval
 * (`routes/approvals.ts`), and the mutation routes that must act without one when
 * the caller is a person (`routes/config.ts`, `routes/marketplace.ts`,
 * `routes/tasks.ts`, `routes/extensions-approval.ts` — the first two reach it both
 * directly and through `trustedCaller`, the last two through one path each).
 *
 * They share this reader rather than each pulling headers off a request, because
 * the failure that matters here is not a wrong answer but a DIVERGENT one: if the
 * decide endpoint and the act-without-approval path disagree about what counts as
 * a person, one of them is wrong and nothing says which. Keeping the read in one
 * place is what lets the guarantee be stated as a single sentence — whoever may
 * decide an approval may act without one — and stay true.
 *
 * ## The second, stricter bar, and why it is two pieces
 *
 * Clearing `resolveDecisionAuthority` is not always enough. Under the default
 * `local-trust` posture that resolver allows any caller presenting neither an
 * agent header nor an approval token, which an agent with a shell reaches by
 * omitting two headers.
 *
 * The stricter bar is split into the two independent questions it was always
 * asking at once, because the surfaces that need it need different halves:
 *
 * - {@link requireStandingGrantsLogin} — is login on at all? This one is specific
 *   to standing permissions, which cannot exist in a posture with no accounts.
 * - {@link requireOperatorCookieUnderLogin} — with login on, is this a person in
 *   the cockpit rather than something holding a per-user API key? **With login
 *   off it allows, because there is no cookie for anyone to present.** That allow
 *   is the residual DOR-505 could not close, and putting it in its own function
 *   is what makes the posture it covers readable instead of buried. Four surfaces
 *   run it now: `PATCH /api/config` on its operator-only paths, extension
 *   approval, opening a standing permission, and — since DOR-474 — answering any
 *   approval at all.
 *
 * {@link requireOperatorCookie} composes both, for the one surface that needs
 * both: creating a standing permission.
 *
 * Since DOR-474, DECIDING an approval runs
 * {@link requireOperatorCookieUnderLogin} too, and not only when the caller asked
 * for a standing permission: an agent legitimately holds one of the person's API
 * keys, so under login-on it could otherwise answer the very request it made.
 * `trustedCaller` applies the same bar for the same reason, which is what keeps
 * "whoever may decide may act without one" true in both directions.
 *
 * They live here for the same anti-divergence reason as the reader above —
 * several routes enforce them and they must not mean different things by it.
 *
 * @module lib/caller-authority
 */
import type { Request, Response } from 'express';

import type {
  DecisionAuthorityRequest,
  LoginEnabledLookup,
} from '../services/core/approvals/index.js';
import { APPROVAL_TOKEN_HEADER } from '../services/core/capabilities/index.js';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import type { RequestUser } from '../services/core/auth/session-gate.js';
import { configManager } from '../services/core/config-manager.js';

/**
 * Build the {@link DecisionAuthorityRequest} for an incoming request.
 *
 * An agent counts as present if EITHER the middleware resolved one or the raw
 * `X-DorkOS-Agent` header is there at all: a header that did not resolve (a
 * revoked or expired agent) still means a machine is calling, and a person in the
 * cockpit never sends it. That is {@link presentsAgentIdentity}, which lives in
 * the module that owns the header because a second surface reads it now
 * (`GET /api/rooms/:id/sessions`) and the two must not diverge.
 *
 * @param req - The incoming request.
 * @param res - The response carrying `sessionGate`'s resolved user.
 * @returns What the caller presented, for `resolveDecisionAuthority`.
 */
export function readCallerAuthority(req: Request, res: Response): DecisionAuthorityRequest {
  const user = res.locals.user as RequestUser | undefined;
  return {
    agentIdentityPresented: presentsAgentIdentity(req, res),
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
 * read failure THROWS rather than returning something falsy. The throw propagates,
 * the request never reaches the write, and the caller gets a 500 instead of a
 * decision.
 *
 * **The throw is the whole guarantee, and no default value could stand in for
 * it.** There is deliberately no claim here that a `false` would have been
 * equivalent, because it would not be: the two callers read the answer in
 * OPPOSITE directions. `false` refuses in {@link requireStandingGrantsLogin} and
 * ALLOWS in {@link requireOperatorCookieUnderLogin}, which treats login-off as
 * "no cookie to ask for". So a fallback of either polarity would be wrong for one
 * of them, and only the throw is right for both.
 */
function loginEnabledFromConfig(): boolean {
  return configManager.get('auth')?.enabled === true;
}

/**
 * Require that local login is on, for the effects that cannot exist without it.
 *
 * Standing permissions are the whole of that set today. A standing permission is
 * a window in which DorkOS stops asking, so the only thing that makes one
 * defensible is that a real account had to open it. With login off there are no
 * accounts, so there is nothing to attribute it to and no way to tell the person
 * from a program running as them.
 *
 * This is deliberately a SEPARATE bar from
 * {@link requireOperatorCookieUnderLogin}, not a special case inside it. That one
 * allows every caller while login is off, which is right for an ordinary setting
 * and wrong here: the tier gate reads `approvals.standingGrants` on every gated
 * call, so a caller that could write it in the login-off posture would be arming
 * the thing that makes DorkOS stop asking. The value also PERSISTS and nothing
 * revokes it when the posture later widens, so it would still be set once login is
 * on, reading as something the person chose. See `config-write-policy.ts` at
 * REQUIRES_LOGIN_CONFIG_PATHS for the full argument.
 *
 * @param isLoginEnabled - Optional login-state lookup for tests.
 * @returns `undefined` when login is on, or the refusal to answer with.
 */
export function requireStandingGrantsLogin(
  isLoginEnabled?: LoginEnabledLookup
): OperatorCookieRefusal | undefined {
  if ((isLoginEnabled ?? loginEnabledFromConfig)()) return undefined;

  return {
    status: 403,
    code: STANDING_GRANTS_REQUIRE_LOGIN_CODE,
    error:
      'Standing permissions need Require login turned on, because without it DorkOS cannot tell you apart from an agent running on this machine',
  };
}

/**
 * With login ON, require that this request came from a person signed in to the
 * cockpit, proved by a session cookie. With login OFF, allow.
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
 * Under login-on it also separates a person from a program holding one of their
 * per-user API keys, which `sessionGate` accepts as the same identity (DOR-474).
 *
 * ## The login-off half is an allow, and that is the residual
 *
 * With login off there is no cookie for ANYONE, so this bar cannot be applied
 * without locking a person out of their own settings — the cockpit is exactly how
 * they change them, and in the default posture it presents no credential at all.
 * So this returns `undefined` and contributes NOTHING in that posture: whether the
 * caller is refused then rests entirely on whatever other bars the route runs. In
 * `routes/config.ts` that is the agent bar, which refuses a caller naming itself
 * an agent and nothing else. That is the open half of DOR-505, stated here rather
 * than implied: **in the login-off posture DorkOS cannot tell the cockpit from a
 * program on the same machine that strips its agent header, and this function does
 * not pretend otherwise.** Turning on Require login is what closes it.
 *
 * Callers that must refuse in BOTH postures need to run
 * {@link requireStandingGrantsLogin} as well; this one cannot do it for them.
 *
 * This is a SERVER-side guarantee. The cockpit also hides and disables the
 * controls this refuses, but that is a courtesy; this is the guarantee.
 *
 * @param res - The response carrying `sessionGate`'s resolved user.
 * @param subject - What the caller tried to change, as the refusal names it, so
 *   one bar can serve several surfaces without any of them inheriting another's
 *   wording. Reads as "Only a person signed in to DorkOS can change {subject}".
 *   A surface whose effect is not a CHANGE to something (deciding an approval) may
 *   keep the status and code and answer with its own sentence, the way
 *   `routes/config.ts` already does.
 * @param isLoginEnabled - Optional login-state lookup for tests.
 * @returns `undefined` when login is off, or when the caller presented a session
 *   cookie. Otherwise the refusal to answer with.
 */
export function requireOperatorCookieUnderLogin(
  res: Response,
  subject: string,
  isLoginEnabled?: LoginEnabledLookup
): OperatorCookieRefusal | undefined {
  if (!(isLoginEnabled ?? loginEnabledFromConfig)()) return undefined;

  const user = res.locals.user as RequestUser | undefined;
  if (user?.credential === 'cookie') return undefined;

  return {
    status: 403,
    code: OPERATOR_COOKIE_REQUIRED_CODE,
    error: `Only a person signed in to DorkOS can change ${subject}`,
  };
}

/**
 * Both bars, for creating a standing permission: login has to be on, and the
 * caller has to be a person in the cockpit.
 *
 * @param res - The response carrying `sessionGate`'s resolved user.
 * @param isLoginEnabled - Optional login-state lookup for tests.
 * @returns `undefined` when the caller clears both bars, or the first refusal.
 */
export function requireOperatorCookie(
  res: Response,
  isLoginEnabled?: LoginEnabledLookup
): OperatorCookieRefusal | undefined {
  return (
    requireStandingGrantsLogin(isLoginEnabled) ??
    requireOperatorCookieUnderLogin(res, 'standing permissions', isLoginEnabled)
  );
}
