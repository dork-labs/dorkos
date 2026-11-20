/**
 * The two person bars every approval answer clears (`routes/approvals.ts`):
 * who may decide at all, and, under login, that a person in the app is the
 * one answering (DOR-474). Kept apart from the routes so that file stays
 * under its line limit.
 *
 * @module routes/approval-person-bars
 */
import {
  resolveDecisionAuthority,
  type DecisionAuthorityResult,
  type LoginEnabledLookup,
} from '../services/core/approvals/index.js';
import {
  readCallerAuthority,
  requireOperatorCookieUnderLogin,
  type OperatorCookieRefusal,
} from '../lib/caller-authority.js';
import type { RequestFacts } from '../http/request-facts.js';

/**
 * Decide whether this request may record a decision.
 *
 * The request facts come from {@link readCallerAuthority}, shared with the two
 * mutation routes that skip the tier gate for a person (DOR-467) — so "who counts
 * as a person" cannot mean one thing at the endpoint that DECIDES an approval and
 * something else at the endpoints that act without one.
 *
 * @param facts - The request's facts, with the session gate's resolved user.
 * @param isLoginEnabled - Optional login-state lookup for tests.
 * @returns Permission with its posture, or a structured refusal.
 */
export function decisionAuthority(
  facts: RequestFacts,
  isLoginEnabled?: LoginEnabledLookup
): DecisionAuthorityResult {
  return resolveDecisionAuthority({
    ...readCallerAuthority(facts),
    ...(isLoginEnabled ? { loginEnabled: isLoginEnabled } : {}),
  });
}

/**
 * What a caller is told when it tried to answer an approval without a session
 * cookie while login is on.
 *
 * Written for whoever ends up reading it, which is often an agent relaying it to
 * a person: it says WHERE the answer has to happen, not which header was missing.
 * A refusal that names a header reads as a hint about how to get around it.
 */
const DECIDE_NEEDS_APP =
  'Approving or refusing a risky action has to happen inside DorkOS, by a person who is signed in. ' +
  'A program holding an API key cannot answer for you. Open DorkOS and answer it there.';

/**
 * With login on, require that a person in the app is answering (DOR-474).
 *
 * The same predicate `PATCH /api/config` and the extension-approval route use, so
 * "who counts as a person" cannot mean one thing here and another there. Only the
 * sentence differs, because the shared one is worded for changing a SETTING and
 * this is not one — the same split `routes/config.ts` already makes when it keeps
 * `refusal.code` and supplies its own `error`.
 *
 * Runs AFTER `resolveDecisionAuthority`, so a caller that names itself an agent
 * still hears `AGENT_CANNOT_DECIDE`. That answer is more specific and more useful
 * than "sign in", and an honest agent should be told the thing it did wrong.
 *
 * @param facts - The request's facts, with the session gate's resolved user.
 * @param isLoginEnabled - Optional login-state lookup for tests.
 * @returns `undefined` when the caller may decide, or the refusal to answer with.
 */
export function requirePersonToDecide(
  facts: RequestFacts,
  isLoginEnabled?: LoginEnabledLookup
): OperatorCookieRefusal | undefined {
  const refusal = requireOperatorCookieUnderLogin(
    facts,
    'whether a risky action goes ahead',
    isLoginEnabled
  );
  return refusal ? { ...refusal, error: DECIDE_NEEDS_APP } : undefined;
}
