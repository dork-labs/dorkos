/**
 * What `readCallerPrincipal` calls each kind of caller (spec `ask-entitlement`
 * §1).
 *
 * The case that carries the weight is the LAST one: a caller holding a valid
 * credential AND presenting an unresolvable agent header. Asking the credential
 * question first would call it a person, which is the precedence mistake DOR-474
 * exists for — an agent legitimately holds one of the person's per-user API
 * keys, so the credential alone cannot separate them.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import type { RequestFacts } from '../../http/request-facts.js';

import { readCallerPrincipal } from '../caller-principal.js';
import { AGENT_IDENTITY_HEADER } from '../../middleware/agent-identity.js';

/** The headers a caller sent. */
function requestWith(headers: Record<string, string> = {}) {
  return { headers };
}

/** What the gate and the identity step resolved. */
function responseWith(locals: Record<string, unknown> = {}) {
  return locals;
}

/** A request's facts from what the caller sent and what resolved. */
function principalOf(
  req: ReturnType<typeof requestWith>,
  resolved: ReturnType<typeof responseWith>
) {
  return readCallerPrincipal({
    headers: req.headers,
    user: resolved.user as RequestFacts['user'],
    agentIdentity: resolved.agentIdentity as RequestFacts['agentIdentity'],
  });
}

describe('readCallerPrincipal', () => {
  it('calls a caller presenting nothing the operator', () => {
    expect(principalOf(requestWith(), responseWith())).toEqual({ kind: 'operator' });
  });

  it('calls a caller with a session cookie the operator', () => {
    const principal = principalOf(
      requestWith(),
      responseWith({ user: { userId: 'user_owner', credential: 'cookie' } })
    );
    expect(principal).toEqual({ kind: 'operator' });
  });

  it('calls a caller holding a per-user API key a program, and names the user', () => {
    const principal = principalOf(
      requestWith(),
      responseWith({ user: { userId: 'user_owner', credential: 'api-key' } })
    );
    expect(principal).toEqual({ kind: 'program', userId: 'user_owner' });
  });

  it('calls a caller whose agent token resolved an agent', () => {
    const principal = principalOf(
      requestWith({ [AGENT_IDENTITY_HEADER]: 'tok_good' }),
      responseWith({ agentIdentity: { agentId: 'agent_ana' } })
    );
    expect(principal).toEqual({ kind: 'agent' });
  });

  it('calls a caller whose agent token did NOT resolve an agent', () => {
    // A revoked or expired token is still a machine calling.
    const principal = principalOf(
      requestWith({ [AGENT_IDENTITY_HEADER]: 'garbage' }),
      responseWith()
    );
    expect(principal).toEqual({ kind: 'agent' });
  });

  it('calls a caller with BOTH a credential and an unresolvable agent header an agent', () => {
    // The ordering case. Ask the credential question first and this reads as a
    // program — which is how an agent holding the person's own key would slip
    // past a policy written in terms of the principal.
    const principal = principalOf(
      requestWith({ [AGENT_IDENTITY_HEADER]: 'garbage' }),
      responseWith({ user: { userId: 'user_owner', credential: 'api-key' } })
    );
    expect(principal).toEqual({ kind: 'agent' });
  });

  it('calls a caller with BOTH a cookie and a resolved agent header an agent', () => {
    const principal = principalOf(
      requestWith({ [AGENT_IDENTITY_HEADER]: 'tok_good' }),
      responseWith({
        user: { userId: 'user_owner', credential: 'cookie' },
        agentIdentity: { agentId: 'agent_ana' },
      })
    );
    expect(principal).toEqual({ kind: 'agent' });
  });
});
