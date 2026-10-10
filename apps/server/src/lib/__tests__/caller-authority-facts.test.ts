/**
 * The person bars, asked of a request's facts through each chain (DOR-2794).
 *
 * `caller-authority.test.ts` covers the cookie bar and the app-window marker;
 * this covers the three readers a moved route calls with `honoRequestFacts`:
 * what a caller presented, whether it clears the agent bar, and whether it may
 * act on the linked account. Each case runs once per adapter.
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
}));

import type { RequestUser } from '../../services/core/auth/session-gate.js';
import { APPROVAL_TOKEN_HEADER } from '../../services/core/capabilities/index.js';
import { REQUEST_FACTS_ADAPTERS } from '../../http/__tests__/request-facts-adapters.js';
import {
  clearsTheAgentBar,
  readCallerAuthority,
  refuseUnlessAccountOwner,
} from '../caller-authority.js';

const OWNER_COOKIE: RequestUser = { userId: 'user_owner', credential: 'cookie' };
const OWNER_KEY: RequestUser = { userId: 'user_owner', credential: 'api-key' };
const GUEST_COOKIE: RequestUser = { userId: 'user_guest', credential: 'cookie' };

afterEach(() => {
  state.login = false;
  state.ownerId = 'user_owner';
});

describe.each(REQUEST_FACTS_ADAPTERS)('through the $name adapter', (adapter) => {
  describe('readCallerAuthority', () => {
    it('reports an agent header, an approval token and the user', async () => {
      const facts = await adapter.facts({
        headers: { 'x-dorkos-agent': 'token', [APPROVAL_TOKEN_HEADER]: 'tok' },
        user: OWNER_COOKIE,
      });
      expect(readCallerAuthority(facts)).toEqual({
        agentIdentityPresented: true,
        approvalTokenPresented: true,
        user: OWNER_COOKIE,
      });
    });

    it('reports a resolved agent even without the raw header', async () => {
      const facts = await adapter.facts({ agentIdentity: { agentId: 'a' } as never });
      expect(readCallerAuthority(facts).agentIdentityPresented).toBe(true);
    });

    it('reports nothing for a plain caller', async () => {
      expect(readCallerAuthority(await adapter.facts({}))).toEqual({
        agentIdentityPresented: false,
        approvalTokenPresented: false,
      });
    });
  });

  describe('clearsTheAgentBar', () => {
    it('clears the operator on the login-off machine', async () => {
      expect(clearsTheAgentBar(await adapter.facts({}))).toBe(true);
    });

    it('refuses an agent and an approval-token holder in every posture', async () => {
      const agent = await adapter.facts({ headers: { 'x-dorkos-agent': 'token' } });
      const requester = await adapter.facts({ headers: { [APPROVAL_TOKEN_HEADER]: 'tok' } });
      expect(clearsTheAgentBar(agent)).toBe(false);
      expect(clearsTheAgentBar(requester)).toBe(false);
      state.login = true;
      expect(
        clearsTheAgentBar(
          await adapter.facts({ headers: { 'x-dorkos-agent': 't' }, user: OWNER_COOKIE })
        )
      ).toBe(false);
    });

    it('under login-on, clears a browser session and refuses an API key', async () => {
      state.login = true;
      expect(clearsTheAgentBar(await adapter.facts({ user: OWNER_COOKIE }))).toBe(true);
      expect(clearsTheAgentBar(await adapter.facts({ user: OWNER_KEY }))).toBe(false);
      expect(clearsTheAgentBar(await adapter.facts({}))).toBe(false);
    });
  });

  describe('refuseUnlessAccountOwner', () => {
    it('lets the operator act on the login-off machine', async () => {
      expect(refuseUnlessAccountOwner(await adapter.facts({}))).toBeUndefined();
    });

    it('refuses an agent as not a person', async () => {
      const agent = await adapter.facts({ headers: { 'x-dorkos-agent': 'token' } });
      expect(refuseUnlessAccountOwner(agent)).toBe('not-a-person');
    });

    it('under login-on, lets only the owner act', async () => {
      state.login = true;
      expect(refuseUnlessAccountOwner(await adapter.facts({ user: OWNER_COOKIE }))).toBeUndefined();
      expect(refuseUnlessAccountOwner(await adapter.facts({ user: GUEST_COOKIE }))).toBe(
        'not-the-owner'
      );
      state.ownerId = null;
      expect(refuseUnlessAccountOwner(await adapter.facts({ user: OWNER_COOKIE }))).toBe(
        'not-the-owner'
      );
    });
  });
});
