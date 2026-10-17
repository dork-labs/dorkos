/**
 * When a doc comment's words count as the owner's request (DOR-2983): only
 * through the person bars, in both login postures. Resolving to the owner's
 * author is not enough.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RequestFacts } from '../../http/request-facts.js';

const posture = vi.hoisted(() => ({ loginOn: false, atThisComputer: true, owner: true }));

vi.mock('../../services/core/auth/gate-policy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/gate-policy.js')>()),
  credentialGated: () => posture.loginOn,
  isAtThisComputer: () => posture.atThisComputer,
}));
vi.mock('../../services/core/auth/install-owner.js', () => ({
  isInstallOwner: () => posture.owner,
}));

const { isOwnerInPerson } = await import('../doc-comment-caller.js');

function facts(overrides: {
  headers?: Record<string, string>;
  user?: RequestFacts['user'];
  agentIdentity?: RequestFacts['agentIdentity'];
}): RequestFacts {
  return {
    headers: overrides.headers ?? {},
    peerAddress: '127.0.0.1',
    forwardedAddress: '127.0.0.1',
    connectionEncrypted: false,
    ingress: 'direct',
    user: overrides.user,
    agentIdentity: overrides.agentIdentity,
  } as RequestFacts;
}

const APP = { 'x-client-id': 'tab-1' };

afterEach(() => {
  posture.loginOn = false;
  posture.atThisComputer = true;
  posture.owner = true;
});

describe('isOwnerInPerson, login off', () => {
  it('is the app at this computer: its client id, no agent header and no bearer', () => {
    expect(isOwnerInPerson(facts({ headers: APP }))).toBe(true);
  });

  it('is not a program that dropped its agent header but sends no client id', () => {
    expect(isOwnerInPerson(facts({}))).toBe(false);
  });

  it('is not anything presenting an agent header, a bearer or an approval token', () => {
    expect(isOwnerInPerson(facts({ headers: { ...APP, 'x-dorkos-agent': 'tok' } }))).toBe(false);
    expect(isOwnerInPerson(facts({ headers: { ...APP, authorization: 'Bearer k' } }))).toBe(false);
    expect(isOwnerInPerson(facts({ headers: { ...APP, 'x-dorkos-approval': 'a' } }))).toBe(false);
  });

  it('is not a request from somewhere other than this computer', () => {
    posture.atThisComputer = false;
    expect(isOwnerInPerson(facts({ headers: APP }))).toBe(false);
  });
});

describe('isOwnerInPerson, login on', () => {
  it('is a browser session', () => {
    posture.loginOn = true;
    expect(
      isOwnerInPerson(
        facts({ headers: APP, user: { userId: 'u1', credential: 'cookie' } as never })
      )
    ).toBe(true);
  });

  it('is not the owner’s API key, even without an agent header', () => {
    posture.loginOn = true;
    expect(
      isOwnerInPerson(
        facts({ headers: APP, user: { userId: 'u1', credential: 'api-key' } as never })
      )
    ).toBe(false);
  });
});
