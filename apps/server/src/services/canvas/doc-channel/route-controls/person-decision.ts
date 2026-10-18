/**
 * Proof that a person, not a program, is changing a document's routes.
 *
 * The route-control writes need the same bars an approval decision needs
 * (`routes/approvals.ts`): a caller that names itself an agent or holds an
 * approval token is refused in every posture, and with login on only a session
 * cookie counts. Running those bars in the HTTP layer alone would leave the
 * service trusting whoever called it. So the bars run HERE, and the only way to
 * get a {@link DocRoutePersonDecision} is to pass them: the service refuses any
 * value this module did not mint (DOR-2665).
 *
 * @module services/canvas/doc-channel/route-controls/person-decision
 */
import { resolveDecisionAuthority } from '../../../core/approvals/index.js';
import {
  readCallerAuthority,
  requireOperatorCookieUnderLogin,
} from '../../../../lib/caller-authority.js';
import { DocRouteGrantError } from '../grant-policy.js';

/** The request facts the person bars read. */
export type DocRoutePersonFacts = Parameters<typeof readCallerAuthority>[0] &
  Parameters<typeof requireOperatorCookieUnderLogin>[0];

/** A person who cleared both bars, with what the audit trail records about them. */
export interface DocRoutePersonDecision {
  /** How the decision's authority was established. */
  readonly posture: 'local-trust' | 'signed-in-operator';
  /** The signed-in account, when login is on. */
  readonly decidedByUserId?: string;
  /** The session gate's resolved user, for the Activity line. */
  readonly user?: DocRoutePersonFacts['user'];
}

/** Why a caller is not a person who may change routes. */
export interface DocRoutePersonRefusal {
  status: number;
  code: string;
  error: string;
}

const minted = new WeakSet<object>();

/**
 * Run both person bars and, when they clear, mint the decision the service needs.
 *
 * @param facts - The request's facts, with the session gate's resolved user.
 */
export function decideAsPerson(
  facts: DocRoutePersonFacts
): { decision: DocRoutePersonDecision } | { refusal: DocRoutePersonRefusal } {
  const authority = resolveDecisionAuthority(readCallerAuthority(facts));
  if (!authority.allowed)
    return { refusal: { status: authority.status, code: authority.code, error: authority.error } };
  const notAPerson = requireOperatorCookieUnderLogin(facts, 'which document routes are on');
  if (notAPerson) return { refusal: notAPerson };
  const decision: DocRoutePersonDecision = Object.freeze({
    posture: authority.posture,
    ...(authority.posture === 'signed-in-operator' ? { decidedByUserId: authority.decidedBy } : {}),
    ...(facts.user ? { user: facts.user } : {}),
  });
  minted.add(decision);
  return { decision };
}

/**
 * Refuse anything but a decision {@link decideAsPerson} minted.
 *
 * @param value - What the caller passed as its decision.
 */
export function requirePersonDecision(value: unknown): asserts value is DocRoutePersonDecision {
  if (typeof value !== 'object' || value === null || !minted.has(value))
    throw new DocRouteGrantError('PERSON_REQUIRED', 403);
}
