/**
 * `requirePersonAtThisComputer` (DOR-2946): the bar on the switches that
 * decide whether this computer can be reached from the web. Only the owner,
 * using the app: a browser session of the owner at this computer or on an
 * encrypted connection (DOR-3172), or the open gate at this computer with no
 * credential at all. Never plain-`http` Wi-Fi or the relay.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  login: false,
  ownerId: 'user_owner' as string | null,
  role: 'computer' as 'computer' | 'hub',
}));
vi.mock('../server-role.js', () => ({ currentServerRole: () => state.role }));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn((key: string) => (key === 'auth' ? { enabled: state.login } : undefined)),
  },
}));
vi.mock('../../services/core/auth/index.js', () => ({
  readOwnerAccount: () => (state.ownerId ? { id: state.ownerId } : null),
  hasAnyUser: () => state.ownerId !== null,
}));

import type { RequestFacts } from '../../http/request-facts.js';
import type { RequestUser } from '../../services/core/auth/session-gate.js';
import type { RequestIngress } from '../../services/core/remote/ingress-mark.js';
import { APPROVAL_TOKEN_HEADER } from '../../services/core/capabilities/index.js';
import { requestFactsFor, type DescribedRequest } from '../../http/__tests__/described-request.js';
import {
  NEEDS_PERSON_AT_THIS_COMPUTER,
  refuseFrontDoorChange,
  requirePersonAtThisComputer,
} from '../caller-authority.js';

const OWNER_COOKIE: RequestUser = { userId: 'user_owner', credential: 'cookie' };
const OWNER_KEY: RequestUser = { userId: 'user_owner', credential: 'api-key' };
const GUEST_COOKIE: RequestUser = { userId: 'user_guest', credential: 'cookie' };

/** A request from this computer: a loopback peer asking for a loopback host. */
async function local(described: DescribedRequest = {}): Promise<RequestFacts> {
  return requestFactsFor({
    ...described,
    headers: { host: 'localhost:4242', ...described.headers },
  });
}

/** The same request, arrived through a marked listener. */
async function through(ingress: RequestIngress, described: DescribedRequest = {}) {
  return { ...(await local(described)), ingress };
}

afterEach(() => {
  state.login = false;
  state.ownerId = 'user_owner';
  state.role = 'computer';
});

describe('requirePersonAtThisComputer', () => {
  // The bar alone cannot tell this from an agent's shell on loopback (DOR-505);
  // the session relay routes that open access ask for the owner's password on top.
  it('lets the app at this computer through, with the open gate and no credential', async () => {
    expect(requirePersonAtThisComputer(await local())).toBeUndefined();
  });

  it('lets the owner’s browser session at this computer through', async () => {
    state.login = true;
    expect(requirePersonAtThisComputer(await local({ user: OWNER_COOKIE }))).toBeUndefined();
  });

  it.each([
    ['the session relay', 'relay'],
    ['plain-http Wi-Fi', 'wifi'],
  ] as const)(
    'refuses a request through %s, even with the owner’s session',
    async (_l, ingress) => {
      expect(requirePersonAtThisComputer(await through(ingress, { user: OWNER_COOKIE }))).toBe(
        'not-at-this-computer'
      );
    }
  );

  // Where the owner connects from changes nothing on an encrypted connection (DOR-3172).
  it.each([
    ['the own tunnel', 'own-tunnel'],
    ['managed remote access', 'managed'],
  ] as const)('lets the owner’s browser session through %s', async (_l, ingress) => {
    expect(
      requirePersonAtThisComputer(await through(ingress, { user: OWNER_COOKIE }))
    ).toBeUndefined();
  });

  it.each([
    ['the own tunnel', 'own-tunnel'],
    ['managed remote access', 'managed'],
  ] as const)(
    'refuses everyone but the owner’s browser session through %s',
    async (_l, ingress) => {
      const callers: DescribedRequest[] = [
        {},
        { user: OWNER_KEY },
        { user: GUEST_COOKIE },
        { user: OWNER_COOKIE, headers: { 'x-dorkos-agent': 't' } },
        { user: OWNER_COOKIE, headers: { [APPROVAL_TOKEN_HEADER]: 'tok' } },
      ];
      for (const described of callers) {
        expect(requirePersonAtThisComputer(await through(ingress, described))).toBe('not-a-person');
      }
    }
  );

  // Encrypted is the listener's say, never a header's (Security, DOR-3172).
  // In production a TLS socket counts for nothing yet: DorkOS's own https
  // listener is test homes only until DOR-3173 (`tls-listener.test.ts`).
  it('refuses a plain-http request claiming https, and a TLS socket outside the test runtime', async () => {
    const remote = { 'x-forwarded-for': '100.64.0.7' };
    const tls = await local({ user: OWNER_COOKIE, encrypted: true, headers: remote });
    expect(requirePersonAtThisComputer(tls)).toBe('not-at-this-computer');
    const forged = await local({
      user: OWNER_COOKIE,
      headers: { ...remote, 'x-forwarded-proto': 'https' },
    });
    expect(requirePersonAtThisComputer(forged)).toBe('not-at-this-computer');
    const wifiForged = await through('wifi', {
      user: OWNER_COOKIE,
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(requirePersonAtThisComputer(wifiForged)).toBe('not-at-this-computer');
  });

  it('refuses another device on the network', async () => {
    const facts = await requestFactsFor({
      peer: '192.168.1.31',
      headers: { host: '192.168.1.20:4242' },
      user: OWNER_COOKIE,
    });
    expect(requirePersonAtThisComputer(facts)).toBe('not-at-this-computer');
  });

  it('refuses a page on another site', async () => {
    const facts = await local({ headers: { origin: 'https://evil.example' } });
    expect(requirePersonAtThisComputer(facts)).toBe('not-at-this-computer');
  });

  it('refuses an agent, by header or resolved identity', async () => {
    expect(requirePersonAtThisComputer(await local({ headers: { 'x-dorkos-agent': 't' } }))).toBe(
      'not-a-person'
    );
    expect(
      requirePersonAtThisComputer(await local({ agentIdentity: { agentId: 'a' } as never }))
    ).toBe('not-a-person');
  });

  it('refuses a caller holding an approval token', async () => {
    const facts = await local({ headers: { [APPROVAL_TOKEN_HEADER]: 'tok' } });
    expect(requirePersonAtThisComputer(facts)).toBe('not-a-person');
  });

  it('refuses an API key the gate proved', async () => {
    state.login = true;
    expect(requirePersonAtThisComputer(await local({ user: OWNER_KEY }))).toBe('not-a-person');
  });

  it('refuses any bearer the open gate never read: an API key, an MCP token, a turn bearer', async () => {
    const facts = await local({ headers: { authorization: 'Bearer dork_key' } });
    expect(requirePersonAtThisComputer(facts)).toBe('not-a-person');
  });

  // With no owner yet, the open gate at this computer is the only person there
  // can be, so these headers are the one thing that tells a program apart.
  it.each([
    ['a bearer', { authorization: 'Bearer anything' }],
    ['an API key header', { 'x-api-key': 'garbage' }],
    ['a proxy credential', { 'proxy-authorization': 'Basic Zm9vOmJhcg==' }],
  ])('refuses %s even with no owner yet, valid or not', async (_label, headers) => {
    state.ownerId = null;
    expect(requirePersonAtThisComputer(await local({ headers }))).toBe('not-a-person');
  });

  it('still lets the app through with no owner yet and no credential header', async () => {
    state.ownerId = null;
    expect(requirePersonAtThisComputer(await local())).toBeUndefined();
  });

  it('refuses a signed-in person who is not the install’s owner', async () => {
    state.login = true;
    expect(requirePersonAtThisComputer(await local({ user: GUEST_COOKIE }))).toBe('not-a-person');
  });

  it('refuses a request with no credential when this computer asks for a password', async () => {
    state.login = true;
    expect(requirePersonAtThisComputer(await local())).toBe('not-a-person');
  });
});

describe('refuseFrontDoorChange (DOR-2969)', () => {
  it('lets the owner change a front-door setting over an encrypted connection (DOR-3172)', async () => {
    for (const ingress of ['own-tunnel', 'managed'] as const) {
      expect(
        refuseFrontDoorChange(await through(ingress, { user: OWNER_COOKIE }), 'remote access')
      ).toBeUndefined();
    }
  });

  it('lets the owner at this computer change a front-door setting', async () => {
    expect(refuseFrontDoorChange(await local(), 'remote access')).toBeUndefined();
    state.login = true;
    expect(
      refuseFrontDoorChange(await local({ user: OWNER_COOKIE }), 'remote access')
    ).toBeUndefined();
  });

  it.each([
    ['plain-http Wi-Fi', 'wifi'],
    ['the session relay', 'relay'],
  ] as const)('refuses %s, with a sentence that says where to do it', async (_l, ingress) => {
    const refusal = refuseFrontDoorChange(
      await through(ingress, { user: OWNER_COOKIE }),
      'Wi-Fi access'
    );
    expect(refusal).toEqual({
      status: 403,
      code: NEEDS_PERSON_AT_THIS_COMPUTER,
      error: 'Change Wi-Fi access on the computer DorkOS runs on.',
    });
  });

  it.each([
    ['an agent', { headers: { 'x-dorkos-agent': 't' } }],
    ['an approval token', { headers: { [APPROVAL_TOKEN_HEADER]: 'tok' } }],
    ['a bearer the open gate never read', { headers: { authorization: 'Bearer dork_key' } }],
  ])('refuses %s at this computer', async (_l, described) => {
    expect(refuseFrontDoorChange(await local(described), 'x')).toMatchObject({
      status: 403,
      code: NEEDS_PERSON_AT_THIS_COMPUTER,
    });
  });

  it('refuses an API key and a person who is not the owner, with login on', async () => {
    state.login = true;
    for (const user of [OWNER_KEY, GUEST_COOKIE]) {
      expect(refuseFrontDoorChange(await local({ user }), 'x')).toMatchObject({
        code: NEEDS_PERSON_AT_THIS_COMPUTER,
        error: 'Only the owner can change x, in the app.',
      });
    }
  });

  it("on a hub, takes the owner's own browser session and nothing else", async () => {
    state.role = 'hub';
    expect(refuseFrontDoorChange(await local({ user: OWNER_COOKIE }), 'x')).toBeUndefined();
    for (const described of [
      { user: OWNER_KEY },
      { user: GUEST_COOKIE },
      {},
      { user: OWNER_COOKIE, headers: { 'x-dorkos-agent': 't' } },
    ]) {
      expect(refuseFrontDoorChange(await local(described), 'x')).toMatchObject({
        code: NEEDS_PERSON_AT_THIS_COMPUTER,
      });
    }
  });
});
