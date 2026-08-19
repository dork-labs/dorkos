/**
 * Conformance probe: the bar the answer routes enforce and the entitlement
 * every Ask surface reads must agree about who may answer (spec
 * `ask-entitlement` §4).
 *
 * ## What this proves
 *
 * Two seams now say "this caller may answer an agent's prompt":
 *
 * - **the six answer routes**, through `requirePersonToAnswer` — which is not a
 *   predicate of its own but a composition of `resolveDecisionAuthority` over
 *   `readCallerAuthority`, then `requireOperatorCookieUnderLogin`;
 * - **`askEntitlement`**, which every surface that SHOWS an Ask reads, and
 *   which returns `'answer'` for exactly the callers that may act.
 *
 * They are deliberately not wired to each other: under one account an
 * entitlement check behind the route guard could never fail, and a check that
 * cannot discriminate is worse than none. What keeps them from coming to mean
 * different things is this file. If a future change widens either one — a
 * second cockpit person, a posture change, a new principal — the other has to
 * move in the same commit or this goes red.
 *
 * Modelled on `services/core/approvals/__tests__/person-proof-conformance.test.ts`,
 * and derived from a list of SEAMS rather than routes for the same reason: a new
 * surface that has to decide who may answer adds itself here and gets both
 * directions checked for free.
 *
 * ## What this does NOT prove
 *
 * It does not prove any particular route calls either seam. A handler that
 * simply stopped calling `requirePersonToAnswer` would leave this green;
 * `routes/__tests__/sessions-pending-interactions.test.ts` drives all six
 * through the real router for that half, and the same file drives the list
 * route's filter.
 *
 * ## The caller deliberately not in the table
 *
 * A caller presenting NO credential while login is ON is missing on purpose. It
 * reaches neither seam: `sessionGate` refuses it before any route runs, and
 * `authorizeStreamUpgrade` refuses it before any connection registers. Adding it
 * would only assert that `askEntitlement` re-implements the credential gate,
 * which is a fact it does not read and should not.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';

import { resolveDecisionAuthority } from '../../../core/approvals/index.js';
import {
  readCallerAuthority,
  requireOperatorCookieUnderLogin,
} from '../../../../lib/caller-authority.js';
import { readCallerPrincipal } from '../../../../lib/caller-principal.js';
import { AGENT_IDENTITY_HEADER } from '../../../../middleware/agent-identity.js';
import type { RequestUser } from '../../../core/auth/session-gate.js';
import { askEntitlement } from '../ask-entitlement.js';

/** What a caller presented, in the only terms either seam reads. */
interface ProbeCaller {
  /** How the case reads in a failure message. */
  name: string;
  /** Whether `auth.enabled` is on for this case. */
  loginEnabled: boolean;
  /** The identity `sessionGate` resolved, when there is one. */
  user?: RequestUser;
  /** Whether an `X-DorkOS-Agent` header was presented at all. */
  agentPresented?: boolean;
  /** Whether this caller may answer, which is what both seams must agree on. */
  mayAnswer: boolean;
}

/** One place that decides whether this caller may answer a prompt. */
interface AnswerSeam {
  /** How the seam reads in a failure message. */
  name: string;
  /** Whether this seam lets the caller answer. */
  allows: (caller: ProbeCaller) => boolean;
}

/**
 * The four callers that can actually reach both seams.
 *
 * The agent is the caller this spec exists for: it clears `sessionGate` in
 * every posture and must answer nothing.
 */
const CALLERS: ProbeCaller[] = [
  {
    name: 'an agent presenting its identity header, in the default posture',
    loginEnabled: false,
    agentPresented: true,
    mayAnswer: false,
  },
  {
    name: 'an agent holding one of the person’s API keys, with login on',
    loginEnabled: true,
    user: { userId: 'user_owner', credential: 'api-key' },
    agentPresented: true,
    mayAnswer: false,
  },
  {
    name: 'a program holding a per-user API key, with login on (the DOR-474 caller)',
    loginEnabled: true,
    user: { userId: 'user_program', credential: 'api-key' },
    mayAnswer: false,
  },
  {
    name: 'a person signed in to the cockpit, with login on',
    loginEnabled: true,
    user: { userId: 'user_owner', credential: 'cookie' },
    mayAnswer: true,
  },
  {
    name: 'a person in the cockpit in the default posture, with login off',
    loginEnabled: false,
    mayAnswer: true,
  },
];

/** A request carrying only the header either seam reads off it. */
function requestFor(caller: ProbeCaller): Request {
  return {
    headers: caller.agentPresented ? { [AGENT_IDENTITY_HEADER]: 'tok_probe' } : {},
  } as unknown as Request;
}

/** A response carrying only what either seam reads off it. */
function responseFor(caller: ProbeCaller): Response {
  return { locals: caller.user ? { user: caller.user } : {} } as unknown as Response;
}

const SEAMS: AnswerSeam[] = [
  {
    name: 'the answer routes’ bar (requirePersonToAnswer’s two composed pieces)',
    allows: (caller) => {
      const req = requestFor(caller);
      const res = responseFor(caller);
      const authority = resolveDecisionAuthority({
        ...readCallerAuthority(req, res),
        loginEnabled: () => caller.loginEnabled,
      });
      if (!authority.allowed) return false;
      return (
        requireOperatorCookieUnderLogin(res, 'whether a tool runs', () => caller.loginEnabled) ===
        undefined
      );
    },
  },
  {
    name: 'the shared entitlement (askEntitlement)',
    allows: (caller) =>
      askEntitlement(readCallerPrincipal(requestFor(caller), responseFor(caller)), {
        sessionId: 'sess_probe',
      }) === 'answer',
  },
];

describe('who may answer an Ask means the same thing at every seam', () => {
  it('has more than one seam to compare, and callers on both sides of the line', () => {
    // A one-seam list would agree with itself forever, and a table with only
    // refusals in it would pass against a seam that refuses everybody.
    expect(SEAMS.length).toBeGreaterThan(1);
    expect(CALLERS.some((caller) => caller.mayAnswer)).toBe(true);
    expect(CALLERS.some((caller) => !caller.mayAnswer)).toBe(true);
  });

  for (const seam of SEAMS) {
    for (const caller of CALLERS) {
      it(`${seam.name}: ${caller.mayAnswer ? 'lets' : 'refuses'} ${caller.name}`, () => {
        expect(
          seam.allows(caller),
          caller.mayAnswer
            ? `${seam.name} refused a caller the other seam treats as a person who may ` +
                `answer. A seam that refuses everybody is an outage, not a guard.`
            : `${seam.name} let ${caller.name} answer. The two seams have drifted, and the ` +
                `surfaces that show an Ask no longer agree with the routes that accept one.`
        ).toBe(caller.mayAnswer);
      });
    }
  }
});
