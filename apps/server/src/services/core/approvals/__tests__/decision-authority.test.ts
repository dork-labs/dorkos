/**
 * Tests for who may DECIDE an approval (spec `agent-trust` §3.3).
 *
 * The reproduced defect: the check keyed on the PRESENCE of an agent identity, so a
 * bare request that simply omitted the header decided its own approval. These cases
 * pin the inverted question — proof of a person where proof exists, and a named,
 * documented posture where it does not.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { resolveDecisionAuthority } from '../decision-authority.js';

/** The shape of a request that presents nothing at all: the bare-curl bypass. */
const NOTHING = { agentIdentityPresented: false, approvalTokenPresented: false };

describe('resolveDecisionAuthority', () => {
  describe('with login enabled', () => {
    const loginEnabled = () => true;

    it('refuses a caller with no authenticated user', () => {
      const result = resolveDecisionAuthority({ ...NOTHING, loginEnabled });
      expect(result).toEqual({
        allowed: false,
        status: 401,
        code: 'AUTH_REQUIRED',
        error: 'Sign in to DorkOS to decide an approval',
      });
    });

    it('allows a signed-in person, and names them for the audit trail', () => {
      const result = resolveDecisionAuthority({
        ...NOTHING,
        loginEnabled,
        user: { userId: 'user_123' },
      });
      expect(result).toEqual({
        allowed: true,
        posture: 'signed-in-operator',
        decidedBy: 'user_123',
      });
    });

    it('refuses an authenticated caller that also presents an agent identity', () => {
      const result = resolveDecisionAuthority({
        agentIdentityPresented: true,
        approvalTokenPresented: false,
        loginEnabled,
        user: { userId: 'user_123' },
      });
      expect(result).toMatchObject({ allowed: false, code: 'AGENT_CANNOT_DECIDE' });
    });
  });

  describe('with login disabled (the default posture)', () => {
    const loginEnabled = () => false;

    it('refuses a caller that names itself as an agent', () => {
      const result = resolveDecisionAuthority({
        agentIdentityPresented: true,
        approvalTokenPresented: false,
        loginEnabled,
      });
      expect(result).toMatchObject({ allowed: false, status: 403, code: 'AGENT_CANNOT_DECIDE' });
    });

    it('refuses a caller holding an approval token — the requester is not the decider', () => {
      const result = resolveDecisionAuthority({
        agentIdentityPresented: false,
        approvalTokenPresented: true,
        loginEnabled,
      });
      expect(result).toMatchObject({
        allowed: false,
        status: 403,
        code: 'REQUESTER_CANNOT_DECIDE',
      });
    });

    it('allows a credential-free caller, under a posture that says so out loud', () => {
      // This is the honest limit, not an oversight: with login off there is NO
      // cryptographic difference between the person in the cockpit and an agent
      // running curl on the same machine. Refusing this would break the default
      // product; pretending it is verified would be a lie. So it is allowed, named
      // `local-trust`, and recorded in the Activity feed by the route.
      const result = resolveDecisionAuthority({ ...NOTHING, loginEnabled });
      expect(result).toEqual({
        allowed: true,
        posture: 'local-trust',
        decidedBy: 'Local operator',
      });
    });
  });

  it('checks the machine credentials before the posture, so both postures refuse an agent', () => {
    for (const loginEnabled of [() => true, () => false]) {
      expect(
        resolveDecisionAuthority({
          agentIdentityPresented: true,
          approvalTokenPresented: false,
          loginEnabled,
        })
      ).toMatchObject({ code: 'AGENT_CANNOT_DECIDE' });
    }
  });
});
