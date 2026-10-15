import type { RequestFacts } from '../http/request-facts.js';
import { logger } from '../lib/logger.js';
import { resolveDecisionAuthority } from '../services/core/approvals/index.js';
import {
  readCallerAuthority,
  requireOperatorCookieUnderLogin,
  type OperatorCookieRefusal,
} from '../lib/caller-authority.js';
import { trustedCaller } from '../services/core/capabilities/index.js';
import { getUserById, readOwnerAccount } from '../services/core/auth/index.js';
import { resolveAnswererName } from '../services/identity/operator-profile.js';
import { configManager } from '../services/core/config-manager.js';

/**
 * Who is posting a message, for a new workspace its `workspaceKey` names
 * (DOR-2335): a person at this machine, or anyone else, with the name an
 * approval card shows.
 *
 * @param facts - The raw request facts and resolved identity.
 */
export function workspaceCallerOf(
  facts: Pick<RequestFacts, 'headers' | 'user' | 'agentIdentity'>
): { trusted: boolean; requestedBy?: string } {
  const identity = facts.agentIdentity;
  return {
    trusted: trustedCaller(readCallerAuthority(facts)) !== undefined,
    ...(identity && { requestedBy: identity.displayName || identity.agentPath }),
  };
}

/**
 * What a caller is told when it tried to answer a prompt without being a person
 * signed in on this machine.
 *
 * Written for whoever ends up reading it, which is often an agent relaying it to
 * a person: it says WHERE the answer has to happen, not which header was
 * missing. A refusal that names a header reads as a hint about how to get around
 * it. The same reasoning, and nearly the same sentence, as the capability
 * approvals' `DECIDE_NEEDS_COCKPIT`.
 */
const ANSWERING_NEEDS_COCKPIT =
  'Answering an agent has to happen inside DorkOS, by a person who is signed in. ' +
  'A program holding an API key cannot answer for you. Open DorkOS and answer it there.';

/**
 * Refuse anything that is not a person in the cockpit answering for themselves.
 *
 * These six routes were protected by `sessionGate` alone, which was defensible
 * while the only way to reach them was the session you were looking at.
 * Broadcasting the Ask to every route makes them reachable from everywhere, and
 * DOR-609's lesson is that _who acted_ is not _who may_.
 *
 * **Fail-closed and structural.** An agent that presents its identity header can
 * never answer ANY prompt, its own included, because `readCallerAuthority`
 * reports `agentIdentityPresented` for a header that did not even resolve — a
 * revoked token still means a machine is calling. There is therefore no id to
 * compare and no way to spoof one: "the requester never self-approves" is a
 * property of what the path accepts, not a check it runs.
 *
 * Under login-on, a caller holding a per-user API key is refused too. An agent
 * legitimately holds one of the person's keys — it is how a Codex or OpenCode
 * agent reaches the operator surface at all — which is exactly the residual
 * DOR-474 closed for capability approvals and this closes for tool prompts.
 *
 * With login off `requireOperatorCookieUnderLogin` allows, because there is no
 * cookie for anyone to present. That is the named, documented residual, and it
 * is identical to the one capability approvals carry: see
 * `lib/caller-authority.ts`.
 *
 * Composed from shipped pieces, with no new predicate, so "who counts as a
 * person" cannot mean one thing at an approval and another at a tool prompt.
 *
 * ## Its relationship to `askEntitlement`
 *
 * `services/session/asks/ask-entitlement.ts` is the shared statement of who may
 * answer, and every surface that SHOWS an Ask reads it. This guard is not
 * changed to call it and is not given a second gate: under one account an
 * entitlement check behind this bar could never fail, and a check that cannot
 * discriminate is worse than none. What holds the two together instead is
 * `services/session/asks/__tests__/ask-answer-conformance.test.ts`, which drives
 * the same callers through both and fails if they disagree — so the day a
 * second person exists, one of them cannot quietly widen.
 *
 * @param facts - The raw request facts carrying the session gate's resolved user.
 * @returns `undefined` when the caller may answer, or the refusal to answer with.
 */
export function requirePersonToAnswer(
  facts: Pick<RequestFacts, 'headers' | 'user' | 'agentIdentity'>
): OperatorCookieRefusal | undefined {
  const authority = resolveDecisionAuthority(readCallerAuthority(facts));
  if (!authority.allowed) {
    return { status: authority.status, code: authority.code, error: authority.error };
  }
  const notAPerson = requireOperatorCookieUnderLogin(facts, 'whether a tool runs');
  return notAPerson ? { ...notAPerson, error: ANSWERING_NEEDS_COCKPIT } : undefined;
}

/**
 * What to call whoever is answering, so the receipt in every OTHER window can
 * name them instead of saying only "Already answered at 2:01".
 *
 * Runs only after {@link requirePersonToAnswer} has already decided the caller
 * is a person, which is what makes the answer honest: this resolves a NAME, not
 * an identity, and would be a claim about who acted if anything else could get
 * this far.
 *
 * The name is read here rather than sent by the client for the same reason a
 * room's author is (`routes/room-caller.ts`): a caller that could name itself
 * could sign somebody else's decision. Under login-on that is the signed-in
 * account; with login off it is whoever owns this install, and on an install
 * with no accounts at all it is the name the person told DorkOS to call them.
 * When none of those exists there is nothing honest to print, and the receipt
 * falls back to the unnamed sentence.
 *
 * **This install has exactly one person in it** (ADR 260727-184933 D6), so the
 * name is that person's however they reached the cockpit. It becomes a real
 * lookup the day DorkOS has more than one, which is the same day the Ask needs
 * a per-caller entitlement filter.
 *
 * @param facts - The request facts carrying the session gate's resolved user.
 * @returns The name to put on the receipt, or `undefined` when none is known or
 *   the lookup failed.
 */
export function answeredBy(facts: Pick<RequestFacts, 'user'>): string | undefined {
  const user = facts.user;
  try {
    return resolveAnswererName({
      account: () => (user ? getUserById(user.userId) : readOwnerAccount()),
      configDisplayName: () => configManager.get('profile')?.displayName ?? null,
    });
  } catch (err) {
    // Two disk reads for a cosmetic label sit inside the path that decides
    // whether a tool runs. A locked database or an unreadable config must cost
    // the receipt its name, never the person their answer, so the throw is
    // swallowed here rather than 500ing an approve.
    logger.warn('[POST /answer] could not resolve who is answering; the receipt goes unnamed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
