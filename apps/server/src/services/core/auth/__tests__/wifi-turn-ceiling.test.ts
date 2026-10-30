/**
 * Which Wi-Fi requests hold the turns they start (DOR-3242): every one, except
 * the owner's own verified sign-in from the app's own page. An API key, no
 * sign-in, a teammate, an agent, a sign-in made on another route, or a request
 * another page sent is still held to the runtime's default, as DOR-3037 made it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const owner = vi.hoisted(() => ({ id: 'owner-1' as string | null }));

vi.mock('../index.js', () => ({
  readOwnerAccount: () => (owner.id ? { id: owner.id } : null),
}));

import type { RequestFacts } from '../../../../http/request-facts.js';
import type { RequestUser } from '../session-gate.js';
import {
  WIFI_TURN_CEILING,
  wifiTurnBound,
  wifiTurnCeiling,
  wifiTurnHeld,
} from '../sessions/wifi-turn-ceiling.js';

const HOST = '192.168.1.20:4243';
const OWNER_ON_WIFI: RequestUser = {
  userId: 'owner-1',
  credential: 'cookie',
  sessionId: 'phone',
  route: 'wifi',
};

/** A request's facts: from Wi-Fi unless `ingress` says otherwise. */
function facts(
  user: RequestUser | undefined,
  headers: Record<string, string> = {},
  ingress: RequestFacts['ingress'] = 'wifi'
): RequestFacts {
  return {
    headers: { host: ingress === 'wifi' ? HOST : 'localhost:4242', ...headers },
    peerAddress: ingress === 'wifi' ? '192.168.1.31' : '127.0.0.1',
    forwardedAddress: undefined,
    connectionEncrypted: false,
    ingress,
    user,
    agentIdentity: undefined,
  };
}

beforeEach(() => {
  owner.id = 'owner-1';
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('the owner signed in on Wi-Fi is not held', () => {
  it('runs a turn from the app page as at the desk', () => {
    const own = facts(OWNER_ON_WIFI, {
      origin: `http://${HOST}`,
      'sec-fetch-site': 'same-origin',
    });
    expect(wifiTurnHeld(own)).toBe(false);
    expect(wifiTurnBound(own)).toBeUndefined();
    expect(wifiTurnCeiling(own)).toEqual({});
  });

  it('is not held when the request names no page at all', () => {
    expect(wifiTurnHeld(facts(OWNER_ON_WIFI))).toBe(false);
  });
});

describe('everything else on Wi-Fi is still held', () => {
  const held: [string, RequestFacts][] = [
    ['no sign-in', facts(undefined)],
    ['an API key', facts({ userId: 'owner-1', credential: 'api-key', credentialId: 'k1' })],
    ['a teammate signed in on Wi-Fi', facts({ ...OWNER_ON_WIFI, userId: 'teammate-1' })],
    ['a sign-in with no route', facts({ userId: 'owner-1', credential: 'cookie', sessionId: 's' })],
    ['a sign-in made on another route', facts({ ...OWNER_ON_WIFI, route: 'network' })],
    ['an agent header beside the cookie', facts(OWNER_ON_WIFI, { 'x-dorkos-agent': 'tok' })],
    ['an empty agent header', facts(OWNER_ON_WIFI, { 'x-dorkos-agent': '' })],
    ['another site', facts(OWNER_ON_WIFI, { 'sec-fetch-site': 'cross-site' })],
    ['a sibling site', facts(OWNER_ON_WIFI, { 'sec-fetch-site': 'same-site' })],
    ['a foreign page', facts(OWNER_ON_WIFI, { origin: 'http://192.168.1.99:8080' })],
    ['an https page on this host', facts(OWNER_ON_WIFI, { origin: `https://${HOST}` })],
    ['an opaque origin', facts(OWNER_ON_WIFI, { origin: 'null' })],
  ];

  it.each(held)('%s', (_, request) => {
    expect(wifiTurnHeld(request)).toBe(true);
    expect(wifiTurnBound(request)).toBe(WIFI_TURN_CEILING);
    expect(wifiTurnCeiling(request)).toEqual({ permissionCeiling: WIFI_TURN_CEILING });
  });

  it('holds the owner when no owner is registered', () => {
    owner.id = null;
    expect(wifiTurnHeld(facts(OWNER_ON_WIFI))).toBe(true);
  });

  it('never holds a request that did not come over Wi-Fi', () => {
    expect(wifiTurnHeld(facts(undefined, {}, 'direct'))).toBe(false);
    expect(wifiTurnHeld(facts({ ...OWNER_ON_WIFI, userId: 'teammate-1' }, {}, 'direct'))).toBe(
      false
    );
  });
});
