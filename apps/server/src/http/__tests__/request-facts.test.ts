/**
 * What `honoRequestFacts` reads off a request.
 *
 * The forwarded address is the field that can drift: it must stay the client
 * address Express reported as `req.ip` under `trust proxy, 1`, which the server
 * ran with until DOR-2818, or every rate limiter would start keying callers
 * differently. The table below is every `X-Forwarded-For` shape the parser
 * treats specially, each with the answer Express gave, recorded from Express
 * itself before it left the server.
 */
import { describe, expect, it } from 'vitest';
import { forwardedClientAddress } from '../request-facts.js';
import { requestFactsFor, type DescribedRequest } from './described-request.js';

/** A header shape, and the address Express's `req.ip` reported for it from peer `192.0.2.10`. */
const FORWARDED_FOR_SHAPES: Array<[string, string | undefined, string]> = [
  ['no header', undefined, '192.0.2.10'],
  ['one entry', '203.0.113.1', '203.0.113.1'],
  ['a chain: the last entry is the hop the peer saw', '203.0.113.1, 198.51.100.9', '198.51.100.9'],
  ['no spaces', '203.0.113.1,198.51.100.9', '198.51.100.9'],
  ['padded entries', '  203.0.113.1 ,   198.51.100.9   ', '198.51.100.9'],
  ['a trailing comma', '203.0.113.1,', '203.0.113.1'],
  ['only commas and spaces', ' , ,', '192.0.2.10'],
  ['empty', '', '192.0.2.10'],
  ['an inner space kept', '203.0.113.1 198.51.100.9', '203.0.113.1 198.51.100.9'],
  ['a tab kept', '203.0.113.1,\t198.51.100.9', '\t198.51.100.9'],
  ['IPv6', '2001:db8::1, ::ffff:203.0.113.7', '::ffff:203.0.113.7'],
  ['not an address at all', 'not-an-ip', 'not-an-ip'],
];

describe('forwardedAddress', () => {
  it.each(FORWARDED_FOR_SHAPES)('matches Express req.ip: %s', async (_name, header, expected) => {
    const described: DescribedRequest = {
      peer: '192.0.2.10',
      headers: header === undefined ? {} : { 'X-Forwarded-For': header },
    };
    expect((await requestFactsFor(described)).forwardedAddress).toBe(expected);
    expect(forwardedClientAddress(header, '192.0.2.10')).toBe(expected);
  });

  it('is the peer when the socket reports one and nothing is forwarded', async () => {
    expect((await requestFactsFor({ peer: '192.0.2.10' })).forwardedAddress).toBe('192.0.2.10');
  });

  it('is nothing when there is neither', async () => {
    expect((await requestFactsFor({ peer: null })).forwardedAddress).toBeUndefined();
  });
});

describe('honoRequestFacts', () => {
  it('describes a request as it arrived', async () => {
    const described: DescribedRequest = {
      peer: '::ffff:127.0.0.1',
      encrypted: true,
      headers: { Host: 'localhost:4242', Origin: 'http://localhost:4242', 'X-Client-Id': 'w1' },
      user: { userId: 'user_owner', credential: 'cookie' },
      agentIdentity: { agentId: 'agent_1' } as never,
    };
    const facts = await requestFactsFor(described);
    expect(facts).toMatchObject({
      peerAddress: '::ffff:127.0.0.1',
      connectionEncrypted: true,
      user: described.user,
      agentIdentity: described.agentIdentity,
    });
    expect(facts.headers.host).toBe('localhost:4242');
  });

  it('reports no identity when no step resolved one', async () => {
    const facts = await requestFactsFor({ headers: {} });
    expect(facts.user).toBeUndefined();
    expect(facts.agentIdentity).toBeUndefined();
    expect(facts.connectionEncrypted).toBe(false);
    expect(facts.ingress).toBe('direct');
  });
});
