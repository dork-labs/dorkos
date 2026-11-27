/**
 * The person bar: is a person asking? The one definition behind the extension
 * and system routes that change what only a person may (`refusedNotAPerson` in
 * `routes/extensions-person-bar.ts` is its thin wrapper for a route), the mini
 * apps' `requirePerson`, and the capability mount for a capability that
 * declares `http.callerBar: 'person'` (`routes/capability-dispatch.ts`, on the
 * REST path and on `/invoke` alike). One function, so the order, the codes and
 * the sentences cannot drift between a hand route and the mount (DOR-4978).
 *
 * ## The three bars, in the order they run
 *
 * 1. **The trusted-`Origin` bar.** A browser that sends an `Origin` must send
 *    one in the SERVER's own static set (`resolveTrustedOrigins`), matched
 *    exactly. Never `isTrustedBrowserOrigin`, the repo's general origin policy:
 *    its branch that accepts an `Origin` equal to the request's own
 *    `<scheme>://<Host>` is exactly what DNS rebinding produces (the browser
 *    sends `Host: evil.example` AND `Origin: http://evil.example`, they match,
 *    and a bar built on them never runs). An expected value taken from the
 *    request cannot judge the request. This bar wants "served by DorkOS
 *    itself", so it stays on the static set: nobody unifies it onto the shared
 *    predicate for the sake of consistency. `DORKOS_CORS_ORIGIN` is not
 *    consulted either: "which sites may read my responses" is a different
 *    question from "which page may change what this server runs". The full
 *    reasoning is in `routes/extensions-person-bar.ts`.
 *
 *    A request with no `Origin` (curl, the CLI, the desktop shell) passes: only
 *    browsers send the header, and browsers send it on every POST and DELETE.
 *    The refusal is one fixed sentence ({@link PERSON_BAR_CROSS_SITE}) that
 *    never repeats the request's `Origin`.
 * 2. **The cookie bar.** With login on, only a browser session proves a
 *    person, so an API key alone is refused (`person_only`). With login off it
 *    allows everyone, because then nobody has a cookie.
 * 3. **The agent bar.** An agent identity or an approval token is refused in
 *    every posture.
 *
 * With login off the agent bar is the only one left, so a caller with a key
 * and no agent identity passes. That is the documented residual (DOR-505);
 * turning on Require login closes it. A refusal logs its code only: never the
 * origin, a header or a token.
 *
 * @module lib/http/person-bar
 */
import { problemBody } from '@dorkos/http-kit';
import { PERSON_BAR_CROSS_SITE, type PersonBarCopy } from '@dorkos/shared/capabilities';
import type { Problem, ProblemCode } from '@dorkos/shared/problem';
import type { RequestFacts } from '../../http/request-facts.js';
import { trustedCaller } from '../../services/core/capabilities/trusted-caller.js';
import { readCallerAuthority, requireOperatorCookieUnderLogin } from '../caller-authority.js';
import { logger } from '../logger.js';
import { resolveTrustedOrigins } from '../trusted-origins.js';

export { PERSON_BAR_CROSS_SITE, type PersonBarCopy };

/** A refusal {@link assessPerson} decided on, not yet written. */
export interface PersonRefusal {
  /** The HTTP status to answer with: the problem's own `status`. */
  status: number;
  /** The problem document to answer with (`application/problem+json`). */
  body: Problem;
}

/** A refusal with a code and a sentence, its status taken from the code; logged by code. */
function refusal(code: ProblemCode, detail: string): PersonRefusal {
  logger.debug('[person-bar] refused', { code });
  const body = problemBody(code, { detail });
  return { status: body.status, body };
}

/**
 * Run the three bars without answering: the verdict, for a caller that
 * writes it itself or carries it elsewhere. An isolated extension's router
 * gets this verdict in a header, because the request it sees has the
 * person's cookie and tokens stripped (DOR-2686, spec §7).
 *
 * @param facts - The request's facts (`http/request-facts.ts`): read for
 *   `Origin`, the agent-identity and approval-token headers, and a resolved
 *   session user.
 * @param copy - What this surface says when it refuses.
 * @returns The refusal, or `null` when a person is asking.
 */
export function assessPerson(facts: RequestFacts, copy: PersonBarCopy): PersonRefusal | null {
  const origin = facts.headers.origin;
  if (origin && !resolveTrustedOrigins().includes(origin)) {
    return refusal(copy.code, PERSON_BAR_CROSS_SITE);
  }

  // A caller that is not a signed-in person while login is on: `person_only`,
  // whichever code the surface gives its other bars.
  const cookieRefusal = requireOperatorCookieUnderLogin(facts, copy.subject);
  if (cookieRefusal) return refusal('person_only', `${cookieRefusal.error}.`);

  if (!trustedCaller(readCallerAuthority(facts))) return refusal(copy.code, copy.agent);

  return null;
}
