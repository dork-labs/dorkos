/**
 * The room-write bar (DOR-3017), case by case: only the person, in their own
 * window of the app, may reply in a room thread from a mini app. Every other
 * shape of caller is named here with the refusal it gets.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const gate = vi.hoisted(() => ({ gated: false, owner: false }));
vi.mock('../../services/core/auth/gate-policy.js', () => ({
  personSessionRequired: () => gate.gated || gate.owner,
}));
vi.mock('../../lib/trusted-origins.js', () => ({
  resolveTrustedOrigins: () => ['http://localhost:4242'],
}));

import type { RequestFacts } from '../../http/request-facts.js';
import { refuseRoomWrite } from '../extensions-rooms-bar.js';
import { APPROVAL_TOKEN_HEADER } from '../../services/core/capabilities/index.js';

/** A request from the person's own window, with one thing changed. */
function facts(
  over: Partial<RequestFacts> = {},
  headers: Record<string, string> = {}
): RequestFacts {
  return {
    headers: { origin: 'http://localhost:4242', 'x-client-id': 'web-1', ...headers },
    peerAddress: '127.0.0.1',
    forwardedAddress: '127.0.0.1',
    connectionEncrypted: false,
    ingress: 'direct',
    user: undefined,
    agentIdentity: undefined,
    ...over,
  };
}

beforeEach(() => {
  gate.gated = false;
  gate.owner = false;
});

describe('refuseRoomWrite', () => {
  it('lets the person in their own window through, before anyone owns this install', () => {
    expect(refuseRoomWrite(facts())).toBeUndefined();
  });

  it('asks for the owner’s session once an owner exists, even at this computer (DOR-3330)', () => {
    gate.owner = true;
    expect(refuseRoomWrite(facts())).toBe('not-a-browser-session');
    expect(refuseRoomWrite(facts({ user: { userId: 'u', credential: 'cookie' } }))).toBeUndefined();
  });

  it('refuses anything the session relay carried', () => {
    expect(refuseRoomWrite(facts({ ingress: 'relay' }))).toBe('relayed');
  });

  it('refuses an agent, verified or not', () => {
    expect(refuseRoomWrite(facts({}, { 'x-dorkos-agent': 'token' }))).toBe('agent');
    expect(
      refuseRoomWrite(facts({ agentIdentity: { agentPath: '/a', displayName: 'A' } as never }))
    ).toBe('agent');
  });

  it('refuses a caller holding an approval token', () => {
    expect(refuseRoomWrite(facts({}, { [APPROVAL_TOKEN_HEADER]: 'tok' }))).toBe('agent');
  });

  it('refuses a request with no Origin: a server half or a script', () => {
    const noOrigin = facts();
    delete (noOrigin.headers as Record<string, unknown>).origin;
    expect(refuseRoomWrite(noOrigin)).toBe('no-origin');
  });

  it('refuses a page on another site', () => {
    expect(refuseRoomWrite(facts({}, { origin: 'https://evil.example' }))).toBe('other-site');
  });

  it('refuses a request from no window of the app', () => {
    const noClient = facts();
    delete (noClient.headers as Record<string, unknown>)['x-client-id'];
    expect(refuseRoomWrite(noClient)).toBe('no-app-window');
  });

  it('takes a browser session and refuses an API key', () => {
    gate.gated = true;
    expect(refuseRoomWrite(facts({ user: { userId: 'u', credential: 'cookie' } as never }))).toBe(
      undefined
    );
    expect(refuseRoomWrite(facts({ user: { userId: 'u', credential: 'api-key' } as never }))).toBe(
      'not-a-browser-session'
    );
  });

  it('refuses a gated request that proved nobody', () => {
    gate.gated = true;
    expect(refuseRoomWrite(facts())).toBe('not-a-browser-session');
  });

  it('refuses a bearer even where the gate was open', () => {
    expect(refuseRoomWrite(facts({}, { authorization: 'Bearer k' }))).toBe('not-a-browser-session');
  });

  it.each([['x-api-key'], ['proxy-authorization']])(
    'refuses %s even where the gate was open, valid or not',
    (header) => {
      expect(refuseRoomWrite(facts({}, { [header]: 'garbage' }))).toBe('not-a-browser-session');
    }
  );
});
