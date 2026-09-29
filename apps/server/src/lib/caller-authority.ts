/**
 * Read, from one Express request, exactly the facts that decide WHO a caller is
 * and WHERE it is calling from — the two questions several surfaces each have to
 * answer the same way, kept in one place so they cannot answer them differently.
 *
 * Most of this file is the first question: whether a caller is a person acting
 * for themselves (spec `agent-trust` §3.3, DOR-467). The second is
 * {@link isLocalCaller} at the bottom, and it is here for the identical reason
 * rather than a related one — read its own doc for what it rests on.
 *
 * There is one predicate for that question — `resolveDecisionAuthority` — and two
 * kinds of surface that need it: the endpoints that DECIDE an approval
 * (`routes/approvals.ts`), and the mutation routes that must act without one when
 * the caller is a person (`routes/config.ts`, `routes/marketplace.ts`,
 * `routes/tasks.ts`, `routes/extensions-person-bar.ts` — the first two reach it both
 * directly and through `trustedCaller`, the last two through one path each. The
 * extensions one is a shared bar serving four write routes since DOR-1507, not a
 * single route).
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
 * omitting two headers.
 *
 * {@link requireOperatorCookieUnderLogin} is the second bar: with login on, is
 * this a person in the cockpit rather than something holding a per-user API key?
 * **With login off it allows, because there is no cookie for anyone to present.**
 * That allow is the residual DOR-505 could not close, and putting it in its own
 * function is what makes the posture it covers readable instead of buried.
 * `PATCH /api/config` runs it on its operator-only paths, and so do extension
 * approval, the permission writes, and answering any approval at all.
 *
 * Since DOR-474, DECIDING an approval runs
 * {@link requireOperatorCookieUnderLogin} too: an agent legitimately holds one of
 * the person's API keys, so under login-on it could otherwise answer the very
 * request it made.
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
import { env } from '../env.js';
import { isLocalRequest } from './trusted-origins.js';
import { resolveDecisionAuthority } from '../services/core/approvals/decision-authority.js';

/**
 * Build the {@link DecisionAuthorityRequest} for an incoming request.
 *
 * An agent counts as present if EITHER the middleware resolved one or the raw
 * `X-DorkOS-Agent` header is there at all: a header that did not resolve (a
 * revoked or expired agent) still means a machine is calling, and a person in the
 * cockpit never sends it. That is {@link presentsAgentIdentity}, which lives in
 * the module that owns the header because a second surface reads it now
 * (`routes/room-caller.ts`, for every room route) and the two must not diverge.
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
 * decision. A `false` fallback would be wrong: {@link requireOperatorCookieUnderLogin}
 * reads login-off as "no cookie to ask for" and allows.
 */
function loginEnabledFromConfig(): boolean {
  return configManager.get('auth')?.enabled === true;
}

/**
 * With login ON, require that this request came from a person signed in to the
 * cockpit, proved by a session cookie. With login OFF, allow.
 *
 * ## Why a cookie, and not something weaker
 *
 * Omitting two headers is all `resolveDecisionAuthority` asks for under
 * `local-trust`, so a header-stripping caller clears it. A cookie is the one
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
 * Whether this request came from a person at this machine.
 *
 * Three surfaces ask, and they are the reason this is one function rather than
 * three: `routes/runtimes.ts` and `routes/mcp-oauth.ts` ask in order to REFUSE a
 * caller that is not local, and `routes/config.ts` asks in order to REPORT the
 * same fact to the app, so a person on their phone is told sign-in needs the
 * computer DorkOS runs on instead of being shown a button that 403s (DOR-1655).
 * The first two held byte-identical private copies before that third caller
 * existed, which is the duplication this removes.
 *
 * A report computed even slightly differently from the refusal — `req.hostname`
 * instead of the raw header, a forgotten `DORKOS_ALLOW_INSECURE_BIND` branch —
 * would give the app a story the endpoint contradicts. One reader is what makes
 * "the app is told exactly what the endpoint would do" true rather than merely
 * intended.
 *
 * ## What the answer rests on
 *
 * Two independent signals, and BOTH must hold, because each one alone admits a
 * different attacker (DOR-532 review):
 *
 * - **The TCP peer must be loopback.** This is the part a caller cannot write.
 *   Header-only checks fell to a raw socket from another host on the LAN:
 *   `Host: localhost` from peer `192.168.86.200` returned 200 and would have run
 *   a Homebrew/winget install. `req.hostname` and `req.ip` are both derived
 *   through `trust proxy` from `X-Forwarded-*` and are caller-controlled, so
 *   neither is usable here; only `req.socket.remoteAddress` is.
 * - **The `Host` header must name loopback.** This is the part that stops a
 *   browser. Under DNS rebinding the peer genuinely IS `127.0.0.1` — the request
 *   comes from the user's own browser — but the page was served from `evil.com`,
 *   and the browser writes that into `Host` and cannot lie about it.
 *
 * Socket alone admits the rebound browser; `Host` alone admits the remote
 * caller. Neither substitutes for the other. A live tunnel is the clearest case:
 * its agent runs on this machine, so the peer IS loopback, and only the `Host`
 * check (which sees the public tunnel domain) turns that traffic away. That same
 * case is why the app has to be TOLD this answer — a phone reaching DorkOS over
 * the tunnel looks local at the socket and is not.
 *
 * ## `DORKOS_ALLOW_INSECURE_BIND` relaxes this, as it does the host guard
 *
 * In a container the browser's request arrives from the bridge gateway rather
 * than loopback, so requiring a loopback peer would refuse runtime provisioning
 * for every Docker operator — a feature that works today, broken for the people
 * the flag already exists to accommodate. The flag's established meaning is
 * "this deployment owns its network boundary", and the official image sets it;
 * `docs/self-hosting/docker.mdx` already states that anyone who reaches the
 * published port has full control. Refusing here would not shrink that blast
 * radius (such a caller can already run agent turns and open shells), so it buys
 * nothing and costs a working feature. Honoring the flag is the same decision
 * `middleware/host-guard.ts` makes, for the same reason.
 *
 * The flag reaches the REPORT too, and that is deliberate rather than
 * incidental: under it the connect endpoints accept, so telling a Docker
 * operator that sign-in needs some other computer would be false. The app is
 * told what the endpoint would actually do, never a stricter story of its own.
 *
 * Unflagged — the default on a normal machine — both signals are still required.
 *
 * One residual remains and is inherent: a reverse proxy on this same host
 * connects from `127.0.0.1`, so it is indistinguishable from a local caller at
 * the socket layer (see `isLoopbackPeer` in `lib/trusted-origins.ts`). Its
 * forwarded `Host` normally carries the public name and is refused, but an
 * operator who rewrites `Host` to `localhost` re-opens it.
 *
 * @param req - The incoming request, read for its TCP peer and raw `Host`.
 * @returns True when the request may reach an action reserved for this machine.
 */
export function isLocalCaller(req: Request): boolean {
  return isLocalRequest({
    peer: req.socket.remoteAddress,
    hostHeader: req.headers.host,
    allowInsecureBind: env.DORKOS_ALLOW_INSECURE_BIND,
  });
}

/**
 * Whether this caller is a person, and so trusted to do what only a person may:
 * arm a scheduled task itself (skipping its approval, un-clamping its power,
 * writing the operator-only task fields), or change an agent's runtime, model or
 * effort without a card (DOR-2328).
 * It composes the SAME two bars the approval, config, and extension-approval
 * routes do, and for the same reason: trust here must be POSITIVE, never the mere
 * ABSENCE of an agent marker.
 *
 * ## Two bars, checked together (DOR-1569)
 *
 * - **The cookie bar, under login-on only** ({@link requireOperatorCookieUnderLogin}).
 *   When login is on, `sessionGate` accepts a per-user API key as the same
 *   identity a browser cookie proves (DOR-474). An agent with shell access can
 *   read the operator's key off `~/.dork` and present it while dropping its
 *   `X-DorkOS-Agent` header, so an API key is NOT proof of a person. Only a
 *   session cookie is. This bar refuses every credential but a cookie while login
 *   is on, and — being the `...UnderLogin` half, not the full
 *   `requireOperatorCookie` — it ALLOWS with login off, so the shipped default
 *   posture is unchanged and the residual there stays the documented DOR-505 one.
 * - **The agent bar, in every posture** ({@link resolveDecisionAuthority}). A
 *   caller that names itself an agent, or holds an approval token, is refused.
 *
 * ## Why this replaced trust-by-absence, and what it costs
 *
 * It used to read `resolveDecisionAuthority(...).allowed` alone. Under login-on
 * that clears any valid credential, so an agent that read the operator's API key
 * off disk and dropped its header was trusted to un-clamp `bypassPermissions` and
 * arm a live cron with no approval — the DOR-1569 exploit, observed on a live
 * server. The one signal a header-stripping caller on loopback cannot fake is a
 * session cookie, so under login-on the cookie is now required, exactly as it is
 * to DECIDE an approval (whoever may decide may act without one).
 *
 * The cost is borne by the operator's own login-on CLI: `dorkos task create`
 * presents an API key and no cookie, so under login-on it now PROPOSES a task
 * (parked at `pending_approval`, clamped) for the operator to approve in the
 * cockpit, rather than arming it directly, and `dorkos task update` can no longer
 * set an operator-only field. That is the deliberate, conservative trade of a
 * security fix — an occasional extra approval, never a live full-power cron
 * nobody looked at. This is the DOR-553 question ("should an agent holding the
 * operator's key schedule unattended work?"), answered for tasks: no.
 *
 * @param req - The incoming request.
 * @param res - The response, for `sessionGate`'s resolved user.
 * @returns True only when a person is positively established — a session cookie
 *   under login-on, or the operator on the login-off local machine — with neither
 *   an agent identity nor an approval token presented.
 */
export function clearsTheAgentBar(req: Request, res: Response): boolean {
  if (requireOperatorCookieUnderLogin(res, 'this') !== undefined) return false;
  return resolveDecisionAuthority(readCallerAuthority(req, res)).allowed;
}
