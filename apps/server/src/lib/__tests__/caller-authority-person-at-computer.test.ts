/**
 * `requirePersonAtThisComputer` (DOR-2946): the bar on the switches that
 * decide whether this computer can be reached from the web. Only the owner,
 * at this computer, using the app: a browser session of the owner, or the open
 * gate with no credential at all.
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

import type { RequestFacts } from '../../http/request-facts.js';
import type { RequestUser } from '../../services/core/auth/session-gate.js';
import type { RequestIngress } from '../../services/core/remote/ingress-mark.js';
import { APPROVAL_TOKEN_HEADER } from '../../services/core/capabilities/index.js';
import { requestFactsFor, type DescribedRequest } from '../../http/__tests__/described-request.js';
import { requirePersonAtThisComputer } from '../caller-authority.js';

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
    ['the own tunnel', 'own-tunnel'],
    ['managed remote access', 'managed'],
    ['Wi-Fi', 'wifi'],
  ] as const)(
    'refuses a request through %s, even with the owner’s session',
    async (_l, ingress) => {
      expect(requirePersonAtThisComputer(await through(ingress, { user: OWNER_COOKIE }))).toBe(
        'not-at-this-computer'
      );
    }
  );

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

  it('refuses a signed-in person who is not the install’s owner', async () => {
    state.login = true;
    expect(requirePersonAtThisComputer(await local({ user: GUEST_COOKIE }))).toBe('not-a-person');
  });

  it('refuses a request with no credential when this computer asks for a password', async () => {
    state.login = true;
    expect(requirePersonAtThisComputer(await local())).toBe('not-a-person');
  });
});
