/**
 * Read, from one request, exactly the facts that decide WHO a caller is
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
 * {@link requireOperatorCookieUnderLogin} is the second bar: is this a person
 * in the app, proved by their browser session, rather than something holding a
 * per-user API key or another program? It asks wherever
 * `personSessionRequired` says so: every request the gate asked for a
 * credential, and every request at this computer once an owner exists
 * (DOR-3330). **With no owner it allows, because there is nobody to sign in as.**
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
 * ## Every surface asks the same questions
 *
 * Every function here takes a request's {@link RequestFacts}
 * (`http/request-facts.ts`): a route builds them with `honoRequestFacts`, and a
 * WebSocket upgrade from what it resolved for itself, so each surface is judged
 * by the same lines.
 *
 * @module lib/caller-authority
 */
import type {
  DecisionAuthorityRequest,
  LoginEnabledLookup,
} from '../services/core/approvals/index.js';
import { APPROVAL_TOKEN_HEADER } from '../services/core/capabilities/index.js';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import { isInstallOwner } from '../services/core/auth/install-owner.js';
import {
  credentialGated,
  isAtThisComputer,
  isOnEncryptedConnection,
  personSessionRequired,
} from '../services/core/auth/gate-policy.js';
import { resolveDecisionAuthority } from '../services/core/approvals/decision-authority.js';
import { notePersonSessionMissing } from './person-without-session.js';
import type { RequestFacts } from '../http/request-facts.js';
import { currentServerRole } from './server-role.js';

/**
 * The facts a bar needs to know whether the gate asked this request for a
 * credential ({@link credentialGated}): its TCP peer, headers and ingress.
 */
type GatedFacts = Pick<RequestFacts, 'headers' | 'peerAddress' | 'ingress'> &
  Partial<Pick<RequestFacts, 'connectionEncrypted' | 'method'>>;

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
 * @param facts - The request's facts.
 * @returns What the caller presented, for `resolveDecisionAuthority`.
 */
export function readCallerAuthority(
  facts: Pick<RequestFacts, 'headers' | 'user' | 'agentIdentity'> & GatedFacts
): DecisionAuthorityRequest {
  return {
    agentIdentityPresented: presentsAgentIdentity(facts),
    approvalTokenPresented: facts.headers[APPROVAL_TOKEN_HEADER] !== undefined,
    ...(facts.user ? { user: facts.user } : {}),
    // Per request, never the global setting: another device always proved a
    // credential at the gate. At this computer, once an owner exists, an open
    // gate proves only the place, so the person's session is asked for too
    // (DOR-3330); with no owner there is nobody to prove.
    loginEnabled: () => sessionAskedOf(facts),
  };
}

/**
 * Whether a person bar must see this request's session, recording, when it
 * must and none came, that a bar asked for the one it lacks.
 */
function sessionAskedOf(facts: Pick<RequestFacts, 'headers' | 'user'> & GatedFacts): boolean {
  const asked = personSessionRequired(facts);
  // `resolveDecisionAuthority` refuses exactly this caller: asked, and nobody proved.
  if (asked && !facts.user) notePersonSessionMissing(facts);
  return asked;
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
 * Require that this request came from a person signed in to the app, proved
 * by a session cookie, wherever one can exist: whenever the gate asked for a
 * credential, and at this computer once an owner exists (DOR-3330). Allow only
 * where nobody can sign in.
 *
 * ## Why a cookie, and not something weaker
 *
 * Omitting two headers is all `resolveDecisionAuthority` asks for under
 * `local-trust`, so a header-stripping caller clears it. A cookie is the one
 * signal that separates the cockpit from a header-stripping caller on loopback,
 * and inventing a weaker marker would assert a distinction DorkOS cannot make.
 *
 * Under login-on it also separates a person from a program holding one of their
 * per-user API keys, which the session gate accepts as the same identity (DOR-474).
 *
 * ## Where it allows
 *
 * Only where no session can exist: an install with no owner yet, at this
 * computer. There the cookie bar contributes nothing and the route's other bars
 * decide. Everywhere else the person proves themselves once: at this computer,
 * a password step-up leaves a long-lived session that works only here
 * (`routes/person-session.ts`), and the gate reads it on every request.
 *
 * The limit (DOR-505, DOR-3053): a program running as the same OS user can read
 * the auth secret and database on disk; this does not close that.
 *
 * This is a SERVER-side guarantee. The cockpit also hides and disables the
 * controls this refuses, but that is a courtesy; this is the guarantee.
 *
 * @param caller - The request's facts, for the session gate's resolved user.
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
  caller: Pick<RequestFacts, 'user'> & GatedFacts,
  subject: string,
  isLoginEnabled?: LoginEnabledLookup
): OperatorCookieRefusal | undefined {
  if (!(isLoginEnabled ? isLoginEnabled() : personSessionRequired(caller))) return undefined;

  if (caller.user?.credential === 'cookie') return undefined;
  if (!caller.user) notePersonSessionMissing(caller);

  return {
    status: 403,
    code: OPERATOR_COOKIE_REQUIRED_CODE,
    error: `Only a person signed in to DorkOS can change ${subject}`,
  };
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
 *   When login is on, the session gate accepts a per-user API key as the same
 *   identity a browser cookie proves (DOR-474). An agent with shell access can
 *   read the operator's key off `~/.dork` and present it while dropping its
 *   `X-DorkOS-Agent` header, so an API key is NOT proof of a person. Only a
 *   session cookie is. This bar refuses every credential but a cookie while login
 *   is on, and — being the `...UnderLogin` half, not the full
 *   `requireOperatorCookie` — it ALLOWS only where no session can exist (no
 *   owner yet, at this computer).
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
 * @param facts - The request's facts.
 * @returns True only when a person is positively established — a session cookie
 *   wherever one can exist, or the person at this computer of an install with
 *   no owner yet — with neither
 *   an agent identity nor an approval token presented.
 */
export function clearsTheAgentBar(
  facts: Pick<RequestFacts, 'headers' | 'user' | 'agentIdentity'> & GatedFacts
): boolean {
  if (requireOperatorCookieUnderLogin(facts, 'this') !== undefined) return false;
  return resolveDecisionAuthority(readCallerAuthority(facts)).allowed;
}

/**
 * Why a caller may not act on the DorkOS account this computer is linked to:
 * `not-a-person` for anything {@link clearsTheAgentBar} refuses, `not-the-owner`
 * for a person signed in to some account other than the one that owns this
 * install.
 */
export type AccountOwnerRefusal = 'not-a-person' | 'not-the-owner';

/**
 * Whether this caller may spend from, or change, the DorkOS account this
 * computer is linked to: a checkout, a top-up, the billing portal, an export,
 * a deletion, the link itself, seats, and which work runs on DorkOS credits.
 *
 * One credential pays for all of it — the instance key this computer holds —
 * so whoever may reach these routes acts as the account. That is the person
 * who owns this install and nobody else, and it takes two bars:
 *
 * - **The person bar, in every posture** ({@link clearsTheAgentBar}). An agent
 *   that names itself, holds an approval token, or (with login on) presents an
 *   API key instead of a browser session is refused.
 * - **The owner bar, with login on.** A signed-in account that is not this
 *   install's owner (`readOwnerAccount`, ADR 260727-184933 D6) is refused. The
 *   registration policy allows only one account today, so this is the same
 *   invariant `routes/profile.ts` and `routes/community-connections.ts` check
 *   rather than assume: an invited person must never be able to buy, export or
 *   delete with the owner's account. With no owner yet there is no signed-in
 *   account to compare, so the person bar alone decides.
 *
 * @param facts - The request's facts.
 * @returns `undefined` when the caller may act, otherwise why not.
 */
export function refuseUnlessAccountOwner(
  facts: Pick<RequestFacts, 'headers' | 'user' | 'agentIdentity'> & GatedFacts
): AccountOwnerRefusal | undefined {
  if (!clearsTheAgentBar(facts)) return 'not-a-person';
  if (!personSessionRequired(facts)) return undefined;
  // Login is on, so the agent bar above has already required a browser
  // session. An install with no owner account to compare against is refused:
  // nobody can be shown to own it.
  return isInstallOwner(facts.user) ? undefined : 'not-the-owner';
}

/**
 * Whether this request is a person using a window of the app, for the one
 * purpose of recording that they touched a chat (spec `your-activity-first`
 * D4): `POST /api/sessions/:id/opened` and an accepted
 * `POST /api/sessions/:id/messages`. Both routes ask this, and only this, so
 * "opened by you" and "written by you" cannot come to mean different callers.
 *
 * Three bars, all of which must hold:
 *
 * - **No agent identity** ({@link presentsAgentIdentity}), in every posture. An
 *   agent waking a chat through this route is the case the rule exists for.
 * - **An `X-Client-Id` header.** Every app window sends one on these calls; a
 *   coordinator curling the messages route from a shell does not. This is a
 *   marker, not a credential: it says which client, not who.
 * - **A browser session under login-on** ({@link requireOperatorCookieUnderLogin}).
 *   An API key is not a person (DOR-474).
 *
 * The residual is DOR-505's: with the password off, a program on this
 * machine that strips its agent header AND sends an `X-Client-Id` reads as the
 * app. That costs only ordering — a chat floats into Today — never power, which
 * is why a marker is enough here when it is not for {@link clearsTheAgentBar}.
 *
 * @param caller - The request's facts.
 * @param isLoginEnabled - Optional login-state lookup for tests.
 * @returns True when the touch should be recorded as yours.
 */
export function isPersonAtTheApp(
  caller: Pick<RequestFacts, 'headers' | 'user' | 'agentIdentity'> & GatedFacts,
  isLoginEnabled?: LoginEnabledLookup
): boolean {
  if (presentsAgentIdentity(caller)) return false;
  const clientId = caller.headers['x-client-id'];
  if (typeof clientId !== 'string' || clientId.length === 0) return false;
  // Only ordering rides on this, so the open gate at this computer still
  // counts as the app without a session (see above).
  return (
    requireOperatorCookieUnderLogin(
      caller,
      'this',
      isLoginEnabled ?? (() => credentialGated(caller))
    ) === undefined
  );
}

/**
 * Whether a message posted to a chat is the person's own turn
 * (`POST /api/sessions/:id/messages`, DOR-3330), rather than agent work.
 *
 * A person's turn can rise to its agent's level and carries no outsider mark,
 * so it needs what every other person-only act needs: no agent identity, and
 * the person's browser session wherever one can exist
 * ({@link requireOperatorCookieUnderLogin}). Anything else still runs, as
 * agent work: chatting never asks for a password, it only stops counting as
 * the person until they prove it once.
 *
 * @param facts - The request's facts.
 */
export function isPersonTurn(
  facts: Pick<RequestFacts, 'headers' | 'user' | 'agentIdentity'> & GatedFacts
): boolean {
  if (presentsAgentIdentity(facts)) return false;
  return requireOperatorCookieUnderLogin(facts, 'this') === undefined;
}

/**
 * Why a caller may not use a switch reserved for the owner in person:
 * `not-at-this-computer` for a request that is neither at this computer nor on
 * an encrypted connection (plain-`http` Wi-Fi, a bare network bind, the
 * relay), `not-a-person` for anything else that is not the owner using the app.
 */
export type PersonAtThisComputerRefusal = 'not-at-this-computer' | 'not-a-person';

/**
 * Headers only a program sends: a bearer, an API key (the gate accepts
 * `x-api-key` as one), or a proxy's credential. The app sends none of them, so
 * any one of them, valid or not, means a program rather than the person.
 */
const PROGRAM_CREDENTIAL_HEADERS = ['authorization', 'x-api-key', 'proxy-authorization'] as const;

/**
 * The strictest person bar: the owner, using the app, at this computer or on
 * an encrypted connection. For the switches that decide how this computer is
 * reached and who may sign in (the front door, the session relay's link,
 * signing other devices out).
 *
 * Where the owner connects from changes nothing (DOR-3172): signed in over the
 * own tunnel, managed remote access or DorkOS's own `https` listener, they get
 * exactly what they get at the desk. Plain-`http` Wi-Fi is
 * the exception, and it is about proof, not place: anyone on that network can
 * copy the sign-in cookie, so a Wi-Fi sign-in does not prove the owner well
 * enough for these.
 *
 * All of these must hold:
 *
 * - **At this computer** ({@link isAtThisComputer}), **or on an encrypted
 *   connection** ({@link isOnEncryptedConnection}) with the owner's own
 *   browser session. Never Wi-Fi, the relay, a hub (which has its own form of
 *   this bar), a bare network bind or a page on another site.
 * - **No agent identity and no approval token**, in every posture.
 * - **A person's own credential, or none at all.** With a proved identity it
 *   must be a browser session (never a per-user API key) of the install's
 *   owner. With none, the request must be at this computer, the gate must have
 *   been open (this computer does not ask for a password) AND the request must
 *   carry no `Authorization`, `X-Api-Key` or `Proxy-Authorization` header: an
 *   API key, an MCP token or a turn's bearer is a program, not the app, even
 *   where the open gate never read it.
 *
 * With no owner yet, a program on this machine that sends no agent header and
 * no credential header reads as the app (DOR-505); once an owner exists it
 * needs their session (DOR-3330).
 *
 * @param facts - The request's facts.
 * @returns `undefined` when the caller may act, otherwise why not.
 */
export function requirePersonAtThisComputer(
  facts: Pick<RequestFacts, 'headers' | 'user' | 'agentIdentity'> & GatedFacts
): PersonAtThisComputerRefusal | undefined {
  const here = isAtThisComputer(facts);
  if (!here && !isOnEncryptedConnection(facts)) return 'not-at-this-computer';
  if (presentsAgentIdentity(facts)) return 'not-a-person';
  if (facts.headers[APPROVAL_TOKEN_HEADER] !== undefined) return 'not-a-person';
  if (facts.user) {
    return facts.user.credential === 'cookie' && isInstallOwner(facts.user)
      ? undefined
      : 'not-a-person';
  }
  // No proved identity: only the open gate at this computer, with no owner who
  // could prove themselves, stands for a person (DOR-3330).
  if (!here) return 'not-a-person';
  if (personSessionRequired(facts)) {
    notePersonSessionMissing(facts);
    return 'not-a-person';
  }
  return PROGRAM_CREDENTIAL_HEADERS.some((name) => facts.headers[name] !== undefined)
    ? 'not-a-person'
    : undefined;
}

/** Refusal code when only the owner, at this computer, may make a change. */
export const NEEDS_PERSON_AT_THIS_COMPUTER = 'NEEDS_PERSON_AT_THIS_COMPUTER';

/**
 * The bar for changing an Owner-only front-door setting (how DorkOS is
 * reached, who may sign in, the credentials it holds, where code may come
 * from): {@link requirePersonAtThisComputer}, as the refusal a route answers
 * with. One function, so every front-door route refuses the same callers in
 * the same words: plain-`http` Wi-Fi, the relay, an agent, an API key, and any
 * signed-in person who is not this install's owner. The owner signed in over
 * the own tunnel, managed remote access or DorkOS's own `https` listener
 * passes, as at the desk.
 *
 * A hub has no "this computer" (every request is remote), so there the bar is
 * the owner's own browser session, with no agent identity or approval token.
 *
 * @param facts - The request's facts.
 * @param subject - What the caller tried to change, as the refusal names it.
 * @returns `undefined` when the caller may act, otherwise the refusal.
 */
export function refuseFrontDoorChange(
  facts: Pick<RequestFacts, 'headers' | 'user' | 'agentIdentity'> & GatedFacts,
  subject: string
): OperatorCookieRefusal | undefined {
  const refusal =
    currentServerRole() === 'hub' ? refuseOnHub(facts) : requirePersonAtThisComputer(facts);
  if (!refusal) return undefined;
  return {
    status: 403,
    code: NEEDS_PERSON_AT_THIS_COMPUTER,
    error:
      refusal === 'not-at-this-computer'
        ? `Change ${subject} on the computer DorkOS runs on.`
        : `Only the owner can change ${subject}, in the app.`,
  };
}

/** The hub's form of the front-door bar: the owner's own browser session. */
function refuseOnHub(
  facts: Pick<RequestFacts, 'headers' | 'user' | 'agentIdentity'>
): PersonAtThisComputerRefusal | undefined {
  if (presentsAgentIdentity(facts)) return 'not-a-person';
  if (facts.headers[APPROVAL_TOKEN_HEADER] !== undefined) return 'not-a-person';
  return facts.user?.credential === 'cookie' && isInstallOwner(facts.user)
    ? undefined
    : 'not-a-person';
}
