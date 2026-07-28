/**
 * Conformance probe: every seam that answers "is a person here?" must give the
 * SAME answer, and must answer "no" to a program holding a per-user API key while
 * login is on (DOR-474).
 *
 * ## What this proves
 *
 * DorkOS has two seams that turn a request into "a person decided this":
 *
 * - **deciding an approval** — the bar `POST /api/approvals/:id/grant|deny` runs
 *   on top of `resolveDecisionAuthority`, which is
 *   {@link requireOperatorCookieUnderLogin};
 * - **acting without deciding** — {@link trustedCaller}, the marker that skips the
 *   tier gate entirely.
 *
 * They are two halves of one guarantee, stated in `trusted-caller.ts`: *whoever
 * may decide an approval may act without one.* That sentence is only safe while
 * both seams accept the same callers. DOR-474 is what happens when they drift: the
 * decide seam let a valid API key through, so an agent handed one approved its own
 * destructive request. Tightening only the decide seam would have inverted the
 * same defect — the shortcut would have granted strictly MORE than deciding does.
 *
 * So this drives both seams with the same four callers and fails if they ever
 * disagree, or if either one accepts the API-key caller under login. It is
 * derived from a list of seams rather than a list of routes on purpose: a new
 * surface that needs proof of a person adds itself here, and gets both directions
 * checked for free.
 *
 * ## What this does NOT prove
 *
 * It does not prove that any particular ROUTE calls a seam. A handler that simply
 * stopped calling `requireOperatorCookieUnderLogin` would leave this green. Two
 * other checks cover that half and neither subsumes this one:
 *
 * - `routes/__tests__/self-approval-chain.test.ts` reproduces the whole DOR-474
 *   chain through the real router, real `sessionGate`, and a real API key, and
 *   asserts the approval is left pending;
 * - `capabilities/__tests__/gate-bypass-scan.test.ts` pins which modules may reach
 *   `approvals.grant(`, `approvals.deny(`, and `trustedCaller(` at all.
 *
 * Nor does it say anything about the login-OFF posture beyond "both seams allow",
 * which is the documented residual and not a guarantee: with no accounts there is
 * no cookie for anyone, and a credential-free caller with shell access is
 * indistinguishable from the cockpit.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import type { Response } from 'express';
import { requireOperatorCookieUnderLogin } from '../../../../lib/caller-authority.js';
import { trustedCaller } from '../../capabilities/trusted-caller.js';
import type { RequestUser } from '../../auth/session-gate.js';

/** What a caller presented, in the only terms both seams read. */
interface ProbeCaller {
  /** How the case reads in a failure message. */
  name: string;
  /** Whether `auth.enabled` is on for this case. */
  loginEnabled: boolean;
  /** The identity `sessionGate` resolved, when there is one. */
  user?: RequestUser;
  /** Whether a person is present, which is what both seams must agree on. */
  isPerson: boolean;
}

/** One place that decides whether a person is present. */
interface PersonProofSeam {
  /** How the seam reads in a failure message. */
  name: string;
  /** Whether this seam lets the caller through. */
  allows: (caller: ProbeCaller) => boolean;
}

/**
 * The callers. None presents an agent identity or an approval token, because
 * those are refused by both seams in every posture and would mask a disagreement
 * rather than expose one.
 */
const CALLERS: ProbeCaller[] = [
  {
    name: 'a program holding a per-user API key, with login on (the DOR-474 caller)',
    loginEnabled: true,
    user: { userId: 'user_program', credential: 'api-key' },
    isPerson: false,
  },
  {
    name: 'a person signed in to the cockpit, with login on',
    loginEnabled: true,
    user: { userId: 'user_owner', credential: 'cookie' },
    isPerson: true,
  },
  {
    name: 'a caller with no credential at all, with login on',
    loginEnabled: true,
    isPerson: false,
  },
  {
    name: 'a caller in the default posture, with login off',
    loginEnabled: false,
    isPerson: true,
  },
];

/** A response carrying only what these seams read off it. */
function responseFor(caller: ProbeCaller): Response {
  return { locals: caller.user ? { user: caller.user } : {} } as unknown as Response;
}

const SEAMS: PersonProofSeam[] = [
  {
    name: 'deciding an approval (requireOperatorCookieUnderLogin)',
    allows: (caller) =>
      requireOperatorCookieUnderLogin(
        responseFor(caller),
        'whether a risky action goes ahead',
        () => caller.loginEnabled
      ) === undefined,
  },
  {
    name: 'acting without deciding (trustedCaller)',
    allows: (caller) =>
      trustedCaller({
        agentIdentityPresented: false,
        approvalTokenPresented: false,
        ...(caller.user ? { user: caller.user } : {}),
        loginEnabled: () => caller.loginEnabled,
      }) !== undefined,
  },
];

describe('proof of a person means the same thing at every seam', () => {
  it('has more than one seam to compare, so it cannot pass vacuously', () => {
    // A one-seam list would agree with itself forever. The whole value here is
    // the comparison, so the comparison has to exist.
    expect(SEAMS.length).toBeGreaterThan(1);
    expect(CALLERS.some((c) => !c.isPerson)).toBe(true);
    expect(CALLERS.some((c) => c.isPerson)).toBe(true);
  });

  for (const seam of SEAMS) {
    for (const caller of CALLERS) {
      it(`${seam.name}: ${caller.isPerson ? 'allows' : 'refuses'} ${caller.name}`, () => {
        expect(
          seam.allows(caller),
          caller.isPerson
            ? `${seam.name} refused a caller every other seam treats as a person. A seam that ` +
                `refuses everybody is an outage, not a guard.`
            : `${seam.name} accepted ${caller.name}. This is the DOR-474 defect: an agent ` +
                `legitimately holds this credential, so accepting it here lets the thing that ` +
                `asked for an approval answer it, or take the shortcut past one.`
        ).toBe(caller.isPerson);
      });
    }
  }
});
