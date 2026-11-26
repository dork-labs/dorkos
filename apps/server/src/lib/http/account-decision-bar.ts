/**
 * Who may make an account decision about this install's connections: the one
 * check behind every route and capability that changes or reveals what belongs
 * to the owner (DOR-4978).
 *
 * Only a person at the DorkOS app clears it: never a page on an origin this
 * server does not serve, never a program (any `Authorization` header), an agent
 * (an `X-DorkOS-Agent` header, verified or not) or a caller holding an approval
 * token. With login on it takes the owner's own browser session, so another
 * signed-in account and an API key are refused too.
 *
 * The hand routes (`routes/connector-owner-boundary.ts`) and the capability
 * mount (`routes/capability-dispatch.ts`, for a capability that declares
 * `http.callerBar: 'account-decision'`) both run {@link accountDecisionBar}, so
 * the order, the codes and the step-up note cannot drift between the two.
 *
 * It is not pure: a refusal for want of the person's session records that on
 * the request ({@link notePersonSessionMissing}), which is what turns the
 * refusal into "Confirm it's you" (`http/person-session-refusal.ts`). A refusal
 * logs its code only: never the origin, a header, a token or the input.
 *
 * @module lib/http/account-decision-bar
 */
import type { RequestFacts } from '../../http/request-facts.js';
import type { RequestUser } from '../../services/core/auth/session-gate.js';
import { isInstallOwner } from '../../services/core/auth/install-owner.js';
import { APPROVAL_TOKEN_HEADER } from '../../services/core/capabilities/approval-wording.js';
import type { ConnectorOwnerAuthority } from '../../services/core/connections-lease/index.js';
import { presentsAgentIdentity } from './agent-identity-header.js';
import { presentsProgramCredential } from '../caller-authority.js';
import { logger } from '../logger.js';
import { notePersonSessionMissing } from '../person-without-session.js';
import { resolveTrustedOrigins } from '../trusted-origins.js';

/** The request facts the bar reads. */
export type AccountDecisionFacts = Pick<
  RequestFacts,
  'headers' | 'peerAddress' | 'ingress' | 'method' | 'user' | 'agentIdentity'
>;

/** The server's policy for the bar, injected at the composition root. */
export interface AccountDecisionPolicy {
  /** Resolve the current deployment's owner from verified server state. */
  readonly resolveOwner: (user: RequestUser | undefined) => ConnectorOwnerAuthority | undefined;
  /**
   * Whether a person-only decision needs the person's browser session here
   * (`personSessionRequired`, DOR-3330); injected for deterministic route
   * evidence.
   */
  readonly loginEnabled: (
    facts: Pick<RequestFacts, 'headers' | 'peerAddress' | 'ingress' | 'method'>
  ) => boolean;
  /** Exact DorkOS browser origins; defaults to the server-owned static set. */
  readonly trustedOrigins?: () => readonly string[];
  /**
   * Whether a signed-in account owns this install; defaults to the shared
   * `isInstallOwner`. Injected for deterministic route evidence.
   */
  readonly isAccountOwner?: (user: RequestUser | undefined) => boolean;
}

/** Why the bar refused, in the order it asks. */
export type AccountDecisionRefusalReason =
  'foreign-origin' | 'machine' | 'no-session' | 'not-the-owner' | 'owner-unknown';

/** A refusal: its problem code and which check refused. */
export interface AccountDecisionRefusal {
  readonly code: 'origin_not_allowed' | 'person_only' | 'owner_only' | 'unauthenticated';
  readonly which: AccountDecisionRefusalReason;
}

/** What the bar answers: the server-owned owner, or why not. */
export type AccountDecisionOutcome =
  | { readonly ok: true; readonly owner: ConnectorOwnerAuthority }
  | { readonly ok: false; readonly refusal: AccountDecisionRefusal };

/**
 * The sentence each refusal says, word for word as the connection routes said
 * them. `not-the-owner` is the area's own ({@link accountDecisionSentence}).
 */
export const ACCOUNT_DECISION_SENTENCES = {
  'foreign-origin': 'Open this account action from the DorkOS app.',
  machine: 'Programs and agents can’t make account decisions.',
  'no-session': 'Sign in to the DorkOS app to make this decision.',
  'owner-unknown': 'DorkOS couldn’t confirm who owns this account.',
} as const satisfies Record<Exclude<AccountDecisionRefusalReason, 'not-the-owner'>, string>;

/**
 * The sentence one refusal answers with.
 *
 * @param which - The check that refused.
 * @param ownerOnly - The area's fixed `owner_only` sentence.
 */
export function accountDecisionSentence(
  which: AccountDecisionRefusalReason,
  ownerOnly: string
): string {
  return which === 'not-the-owner' ? ownerOnly : ACCOUNT_DECISION_SENTENCES[which];
}

/**
 * Whether the request comes from a page on an origin this server does not
 * serve. A request with no `Origin` is not one.
 *
 * @param facts - The request's facts.
 * @param policy - The trusted-origin policy.
 */
export function fromForeignOrigin(
  facts: Pick<RequestFacts, 'headers'>,
  policy: Pick<AccountDecisionPolicy, 'trustedOrigins'>
): boolean {
  const origin = facts.headers.origin;
  if (!origin) return false;
  const trusted = policy.trustedOrigins?.() ?? resolveTrustedOrigins();
  return !trusted.includes(Array.isArray(origin) ? origin[0]! : origin);
}

/**
 * Whether the request carries an agent identity or an approval token: a
 * machine signal, never a person.
 *
 * @param facts - The request's facts.
 */
export function presentsMachineSignal(
  facts: Pick<RequestFacts, 'headers' | 'agentIdentity'>
): boolean {
  return presentsAgentIdentity(facts) || facts.headers[APPROVAL_TOKEN_HEADER] !== undefined;
}

/** A refusal, logged by its code alone. */
function refuse(
  code: AccountDecisionRefusal['code'],
  which: AccountDecisionRefusalReason
): AccountDecisionOutcome {
  logger.debug('[account-decision] refused', { code });
  return { ok: false, refusal: { code, which } };
}

/**
 * Run the account-decision bar, in this order: a foreign origin (`403
 * origin_not_allowed`); an agent, an approval token or any program credential
 * header (`PROGRAM_CREDENTIAL_HEADERS`) (`403 person_only`); with login on, no cookie session (`403
 * person_only`, noted as a missing session when nobody signed in); with login
 * on, a signed-in account that does not own this install (`403 owner_only`);
 * an owner DorkOS can't work out (`401 unauthenticated`).
 *
 * @param facts - The request's facts, carrying the session gate's verified user.
 * @param policy - The deployment owner and the login and origin policy.
 * @returns The server-owned owner, or the refusal.
 */
export function accountDecisionBar(
  facts: AccountDecisionFacts,
  policy: AccountDecisionPolicy
): AccountDecisionOutcome {
  if (fromForeignOrigin(facts, policy)) return refuse('origin_not_allowed', 'foreign-origin');
  // Any program credential header (`PROGRAM_CREDENTIAL_HEADERS`: Authorization,
  // X-API-Key, Proxy-Authorization), read from the one list every person bar uses.
  if (presentsMachineSignal(facts) || presentsProgramCredential(facts)) {
    return refuse('person_only', 'machine');
  }
  const { user } = facts;
  const gated = policy.loginEnabled(facts);
  if (gated && user?.credential !== 'cookie') {
    if (!user) notePersonSessionMissing(facts);
    return refuse('person_only', 'no-session');
  }
  // Connections reach their apps through this computer's DorkOS account, so
  // with login on they are the owner's alone, never another signed-in
  // account's (DOR-2678): the same owner `/api/cloud/*` asks for.
  if (gated && !(policy.isAccountOwner ?? isInstallOwner)(user)) {
    return refuse('owner_only', 'not-the-owner');
  }
  const owner = policy.resolveOwner(user);
  if (!owner) return refuse('unauthenticated', 'owner-unknown');
  return { ok: true, owner };
}
