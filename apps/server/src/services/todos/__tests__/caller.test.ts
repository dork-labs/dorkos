/**
 * Who is calling, for to-dos (DOR-3088): only the owner's own session cookie proves a person
 * (Security's Must for PR 2), and the calling agent's id comes from one function (DOR-3640).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ login: false, ownerId: 'user_owner' as string | null }));
vi.mock('../../core/config-manager.js', () => ({
  configManager: {
    get: vi.fn((key: string) => (key === 'auth' ? { enabled: state.login } : undefined)),
  },
}));
vi.mock('../../core/auth/index.js', () => ({
  readOwnerAccount: () => (state.ownerId ? { id: state.ownerId } : null),
  hasAnyUser: () => state.ownerId !== null,
}));

import type { RequestUser } from '../../core/auth/session-gate.js';
import { APPROVAL_TOKEN_HEADER } from '../../core/capabilities/index.js';
import { requestFactsFor } from '../../../http/__tests__/described-request.js';
import { callerAgentId, personProof } from '../caller.js';

const OWNER_COOKIE: RequestUser = { userId: 'user_owner', credential: 'cookie' };
const OWNER_KEY: RequestUser = { userId: 'user_owner', credential: 'api-key' };
const GUEST_COOKIE: RequestUser = { userId: 'user_guest', credential: 'cookie' };

/** A request from this computer, which is where the open gate lets anything in with login off. */
function here(described: Parameters<typeof requestFactsFor>[0] = {}) {
  return requestFactsFor({
    ...described,
    headers: { host: 'localhost:4242', ...described.headers },
  });
}

afterEach(() => {
  state.login = false;
  state.ownerId = 'user_owner';
});

describe('personProof', () => {
  it('is not proven by the open gate: login off, no headers, no cookie', async () => {
    expect(personProof(await here())).toBe(false);
  });

  it("is proven by the owner's own session cookie", async () => {
    expect(personProof(await here({ user: OWNER_COOKIE }))).toBe(true);
    state.login = true;
    expect(personProof(await here({ user: OWNER_COOKIE }))).toBe(true);
  });

  it('is not proven by an API key, someone else, an agent, or an approval token', async () => {
    expect(personProof(await here({ user: OWNER_KEY }))).toBe(false);
    expect(personProof(await here({ user: GUEST_COOKIE }))).toBe(false);
    expect(
      personProof(await here({ user: OWNER_COOKIE, headers: { 'x-dorkos-agent': 'token' } }))
    ).toBe(false);
    expect(
      personProof(await here({ user: OWNER_COOKIE, headers: { [APPROVAL_TOKEN_HEADER]: 'tok' } }))
    ).toBe(false);
  });

  it('is never proven when no owner account exists', async () => {
    state.ownerId = null;
    expect(personProof(await here({ user: OWNER_COOKIE }))).toBe(false);
  });
});

describe('callerAgentId', () => {
  const lookup = (path: string) => (path === '/agents/ana' ? 'agent-ana' : undefined);

  it('names the agent its verified identity points at', () => {
    expect(callerAgentId({ agentPath: '/agents/ana' }, lookup)).toEqual({
      ok: true,
      agentId: 'agent-ana',
    });
  });

  it('names nobody for no identity, an inactive one, or an agent not on the team', () => {
    expect(callerAgentId(undefined, lookup)).toEqual({ ok: false, code: 'NO_AGENT' });
    expect(callerAgentId({ agentPath: '/agents/ana', inactive: 'revoked' }, lookup)).toEqual({
      ok: false,
      code: 'NO_AGENT',
    });
    expect(callerAgentId({ agentPath: '/agents/zed' }, lookup)).toEqual({
      ok: false,
      code: 'UNKNOWN_AGENT',
    });
  });
});
