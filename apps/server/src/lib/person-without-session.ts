/**
 * The person at this computer, missing only their session (DOR-3330): which
 * requests are that caller, and which of them a person bar refused for it.
 * Its own module, beside `caller-authority.ts` rather than in it, because the
 * `/api` chain asks it about every refused write.
 *
 * @module lib/person-without-session
 */
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import { APPROVAL_TOKEN_HEADER } from '../services/core/capabilities/index.js';
import {
  credentialGated,
  isAtThisComputer,
  personSessionRequired,
} from '../services/core/auth/gate-policy.js';
import type { RequestFacts } from '../http/request-facts.js';

/**
 * The requests a person bar refused for want of the person's session, by
 * their headers object: one per request, shared by every facts object built
 * for it, and gone with it.
 */
const refusedForSession = new WeakSet<object>();

/**
 * Record that a person bar refused this request because no session proved
 * the person. The chain turns the route's refusal into the step-up only for
 * a request marked here ({@link personSessionWasMissing}), so a refusal for
 * any other reason keeps its own words.
 *
 * @param facts - The refused request's facts.
 */
export function notePersonSessionMissing(facts: Pick<RequestFacts, 'headers'>): void {
  refusedForSession.add(facts.headers);
}

/**
 * Whether a person bar refused this request for want of the person's session.
 *
 * @param facts - The request's facts.
 */
export function personSessionWasMissing(facts: Pick<RequestFacts, 'headers'>): boolean {
  return refusedForSession.has(facts.headers);
}

/**
 * Whether this request would be the person at this computer if only it held
 * their session (DOR-3330): at this computer, an open gate, an owner who could
 * prove themselves, and no session, agent identity, approval token or key.
 *
 * A person-only bar refuses exactly this caller, and the app answers it with
 * the owner's one password step-up, so the chain turns such a refusal into
 * `401 person_session_required` (`http/person-session-refusal.ts`). It grants
 * nothing: an agent omitting its headers matches too, and is asked for a
 * password it does not have.
 *
 * @param facts - The request's facts.
 */
export function isPersonWithoutSession(facts: RequestFacts): boolean {
  if (facts.user || presentsAgentIdentity(facts)) return false;
  if (facts.headers[APPROVAL_TOKEN_HEADER] !== undefined) return false;
  if (facts.headers.authorization !== undefined) return false;
  if (credentialGated(facts) || !isAtThisComputer(facts)) return false;
  return personSessionRequired(facts);
}
