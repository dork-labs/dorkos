/**
 * Who is calling, for to-dos (DOR-3088): only the owner's own session cookie proves a person
 * (Security's Must for PR 2), and the calling agent's id comes from one function (DOR-3640).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  login: false,
  ownerId: 'user_owner' as string | null,
  authDb: undefined as unknown,
}));
vi.mock('../../core/config-manager.js', () => ({
  configManager: {
    get: vi.fn((key: string) => (key === 'auth' ? { enabled: state.login } : undefined)),
  },
}));
vi.mock('../../core/auth/index.js', () => ({
  readOwnerAccount: () => (state.ownerId ? { id: state.ownerId } : null),
  hasAnyUser: () => state.ownerId !== null,
  readAuthDb: () => state.authDb,
}));

import { createDb, runMigrations, session, user } from '@dorkos/db';
import type { RequestFacts } from '../../../http/request-facts.js';
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

describe('personProof from Wi-Fi (DOR-5070)', () => {
  const HOST = '192.168.1.20:4243';

  /** The owner's two Wi-Fi sign-ins: the phone was let run agents, the laptop was not. */
  function seedWifiSignIns(): void {
    const db = createDb(':memory:');
    runMigrations(db);
    const now = new Date();
    db.insert(user)
      .values({ id: 'user_owner', name: 'Owner', email: 'owner@dork.test', updatedAt: now })
      .run();
    for (const id of ['phone', 'laptop']) {
      db.insert(session)
        .values({
          id,
          token: `token-${id}`,
          userId: 'user_owner',
          route: 'wifi',
          expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
          updatedAt: now,
          lastActiveAt: now,
          wifiAgentTurnsAt: id === 'phone' ? now : null,
        })
        .run();
    }
    state.authDb = db;
  }

  /** The owner's cookie on a Wi-Fi sign-in, sent by the app's own page. */
  function fromWifi(sessionId: string): RequestFacts {
    return {
      headers: { host: HOST },
      peerAddress: '192.168.1.31',
      forwardedAddress: undefined,
      connectionEncrypted: false,
      ingress: 'wifi',
      user: { userId: 'user_owner', credential: 'cookie', sessionId, route: 'wifi' },
      agentIdentity: undefined,
    };
  }

  afterEach(() => {
    state.authDb = undefined;
  });

  it('is not proven by a Wi-Fi sign-in the owner never let run agents', () => {
    seedWifiSignIns();
    expect(personProof(fromWifi('laptop'))).toBe(false);
  });

  it('is proven by a Wi-Fi sign-in the owner let run agents, as a message from it would be', () => {
    seedWifiSignIns();
    expect(personProof(fromWifi('phone'))).toBe(true);
  });

  it("still holds a Wi-Fi request another page sent on the owner's cookie", () => {
    seedWifiSignIns();
    const facts = fromWifi('phone');
    expect(
      personProof({ ...facts, headers: { ...facts.headers, origin: 'http://evil.example' } })
    ).toBe(false);
  });

  it("leaves the owner's own cookie at this computer as it was", async () => {
    seedWifiSignIns();
    expect(personProof(await here({ user: OWNER_COOKIE }))).toBe(true);
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
