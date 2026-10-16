/**
 * The person bars, asked of a request's facts (DOR-2794).
 *
 * `caller-authority.test.ts` covers the cookie bar and the app-window marker;
 * this covers the three readers a route calls with `honoRequestFacts`: what a
 * caller presented, whether it clears the agent bar, and whether it may act on
 * the linked account.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ login: false, ownerId: 'user_owner' as string | null }));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn((key: string) => (key === 'auth' ? { enabled: state.login } : undefined)),
  },
}));
vi.mock('../../services/core/auth/index.js', () => ({
  readOwnerAccount: () => (state.ownerId ? { id: state.ownerId } : null),
  hasAnyUser: () => state.ownerId !== null,
}));

import type { RequestUser } from '../../services/core/auth/session-gate.js';
import { APPROVAL_TOKEN_HEADER } from '../../services/core/capabilities/index.js';
import { requestFactsFor, type DescribedRequest } from '../../http/__tests__/described-request.js';
import {
  clearsTheAgentBar,
  readCallerAuthority,
  refuseUnlessAccountOwner,
} from '../caller-authority.js';

const OWNER_COOKIE: RequestUser = { userId: 'user_owner', credential: 'cookie' };
const OWNER_KEY: RequestUser = { userId: 'user_owner', credential: 'api-key' };
const GUEST_COOKIE: RequestUser = { userId: 'user_guest', credential: 'cookie' };

/**
 * A request from this computer: a loopback peer (the helper's default) asking
 * for a loopback host. Every bar now decides "login on" per request (ADR
 * 261015-125850), so a case that means this computer has to say so.
 */
function atThisComputer(described: DescribedRequest = {}): ReturnType<typeof requestFactsFor> {
  return requestFactsFor({
    ...described,
    headers: { host: 'localhost:4242', ...described.headers },
  });
}

/** A phone on the LAN: a non-loopback peer, so another device. */
function onAnotherDevice(described: DescribedRequest = {}): ReturnType<typeof requestFactsFor> {
  return requestFactsFor({
    ...described,
    peer: '192.168.1.31',
    headers: { host: '192.168.1.20:4242', ...described.headers },
  });
}

afterEach(() => {
  state.login = false;
  state.ownerId = 'user_owner';
});

describe("on a request's facts", () => {
  describe('readCallerAuthority', () => {
    it('reports an agent header, an approval token and the user', async () => {
      const facts = await atThisComputer({
        headers: { 'x-dorkos-agent': 'token', [APPROVAL_TOKEN_HEADER]: 'tok' },
        user: OWNER_COOKIE,
      });
      expect(readCallerAuthority(facts)).toEqual({
        agentIdentityPresented: true,
        approvalTokenPresented: true,
        user: OWNER_COOKIE,
        loginEnabled: expect.any(Function),
      });
    });

    it('reports a resolved agent even without the raw header', async () => {
      const facts = await atThisComputer({ agentIdentity: { agentId: 'a' } as never });
      expect(readCallerAuthority(facts).agentIdentityPresented).toBe(true);
    });

    it('reports nothing for a plain caller', async () => {
      expect(readCallerAuthority(await atThisComputer({}))).toEqual({
        agentIdentityPresented: false,
        approvalTokenPresented: false,
        loginEnabled: expect.any(Function),
      });
    });

    it('reports login on per request: off at this computer, on for another device', async () => {
      expect(readCallerAuthority(await atThisComputer()).loginEnabled?.()).toBe(false);
      expect(readCallerAuthority(await onAnotherDevice()).loginEnabled?.()).toBe(true);
      state.login = true;
      expect(readCallerAuthority(await atThisComputer()).loginEnabled?.()).toBe(true);
    });
  });

  describe('clearsTheAgentBar', () => {
    it('clears the operator at this computer when it asks for no password', async () => {
      expect(clearsTheAgentBar(await atThisComputer({}))).toBe(true);
    });

    it('on another device, clears only a browser session, whatever this computer asks', async () => {
      // ADR 261015-125850 rule 3: another device always needs a person session.
      expect(clearsTheAgentBar(await onAnotherDevice({}))).toBe(false);
      expect(clearsTheAgentBar(await onAnotherDevice({ user: OWNER_KEY }))).toBe(false);
      expect(clearsTheAgentBar(await onAnotherDevice({ user: OWNER_COOKIE }))).toBe(true);
    });

    it('refuses an agent and an approval-token holder in every posture', async () => {
      const agent = await atThisComputer({ headers: { 'x-dorkos-agent': 'token' } });
      const requester = await atThisComputer({ headers: { [APPROVAL_TOKEN_HEADER]: 'tok' } });
      expect(clearsTheAgentBar(agent)).toBe(false);
      expect(clearsTheAgentBar(requester)).toBe(false);
      state.login = true;
      expect(
        clearsTheAgentBar(
          await atThisComputer({ headers: { 'x-dorkos-agent': 't' }, user: OWNER_COOKIE })
        )
      ).toBe(false);
    });

    it('with the password asked on this computer, clears a browser session and refuses an API key', async () => {
      state.login = true;
      expect(clearsTheAgentBar(await atThisComputer({ user: OWNER_COOKIE }))).toBe(true);
      expect(clearsTheAgentBar(await atThisComputer({ user: OWNER_KEY }))).toBe(false);
      expect(clearsTheAgentBar(await atThisComputer({}))).toBe(false);
    });
  });

  describe('refuseUnlessAccountOwner', () => {
    it('lets the operator act at this computer when it asks for no password', async () => {
      expect(refuseUnlessAccountOwner(await atThisComputer({}))).toBeUndefined();
    });

    it('on another device, lets only the owner act, whatever this computer asks', async () => {
      expect(refuseUnlessAccountOwner(await onAnotherDevice({}))).toBe('not-a-person');
      expect(
        refuseUnlessAccountOwner(await onAnotherDevice({ user: OWNER_COOKIE }))
      ).toBeUndefined();
      expect(refuseUnlessAccountOwner(await onAnotherDevice({ user: GUEST_COOKIE }))).toBe(
        'not-the-owner'
      );
    });

    it('refuses an agent as not a person', async () => {
      const agent = await atThisComputer({ headers: { 'x-dorkos-agent': 'token' } });
      expect(refuseUnlessAccountOwner(agent)).toBe('not-a-person');
    });

    it('with the password asked on this computer, lets only the owner act', async () => {
      state.login = true;
      expect(
        refuseUnlessAccountOwner(await atThisComputer({ user: OWNER_COOKIE }))
      ).toBeUndefined();
      expect(refuseUnlessAccountOwner(await atThisComputer({ user: GUEST_COOKIE }))).toBe(
        'not-the-owner'
      );
      state.ownerId = null;
      expect(refuseUnlessAccountOwner(await atThisComputer({ user: OWNER_COOKIE }))).toBe(
        'not-the-owner'
      );
    });
  });
});
