/**
 * Both adapters must describe one request identically, or a policy would answer
 * differently depending on which chain asked.
 *
 * The forwarded address is the field that can drift: Express computes `req.ip`
 * through `proxy-addr`, and the Hono adapter computes it with
 * `forwardedClientAddress`. The table below is every `X-Forwarded-For` shape the
 * parser treats specially, held against Express's own answer.
 */
import { describe, expect, it } from 'vitest';
import { forwardedClientAddress } from '../request-facts.js';
import { REQUEST_FACTS_ADAPTERS, type DescribedRequest } from './request-facts-adapters.js';

const [viaExpress, viaHono] = REQUEST_FACTS_ADAPTERS;

const FORWARDED_FOR_SHAPES: Array<[string, string | undefined]> = [
  ['no header', undefined],
  ['one entry', '203.0.113.1'],
  ['a chain: the last entry is the hop the peer saw', '203.0.113.1, 198.51.100.9'],
  ['no spaces', '203.0.113.1,198.51.100.9'],
  ['padded entries', '  203.0.113.1 ,   198.51.100.9   '],
  ['a trailing comma', '203.0.113.1,'],
  ['only commas and spaces', ' , ,'],
  ['empty', ''],
  ['an inner space kept', '203.0.113.1 198.51.100.9'],
  ['a tab kept', '203.0.113.1,\t198.51.100.9'],
  ['IPv6', '2001:db8::1, ::ffff:203.0.113.7'],
  ['not an address at all', 'not-an-ip'],
];

describe('forwardedAddress', () => {
  it.each(FORWARDED_FOR_SHAPES)('matches Express req.ip: %s', async (_name, header) => {
    const described: DescribedRequest = {
      peer: '192.0.2.10',
      headers: header === undefined ? {} : { 'X-Forwarded-For': header },
    };
    const expected = (await viaExpress.facts(described)).forwardedAddress;
    expect((await viaHono.facts(described)).forwardedAddress).toBe(expected);
    expect(forwardedClientAddress(header, '192.0.2.10')).toBe(expected);
  });

  it('is the peer when the socket reports one and nothing is forwarded', async () => {
    expect((await viaHono.facts({ peer: '192.0.2.10' })).forwardedAddress).toBe('192.0.2.10');
  });

  it('is nothing when there is neither', async () => {
    expect((await viaExpress.facts({ peer: null })).forwardedAddress).toBeUndefined();
    expect((await viaHono.facts({ peer: null })).forwardedAddress).toBeUndefined();
  });
});

describe('both adapters', () => {
  const described: DescribedRequest = {
    peer: '::ffff:127.0.0.1',
    encrypted: true,
    headers: { Host: 'localhost:4242', Origin: 'http://localhost:4242', 'X-Client-Id': 'w1' },
    user: { userId: 'user_owner', credential: 'cookie' },
    agentIdentity: { agentId: 'agent_1' } as never,
  };

  it('describe one request identically', async () => {
    const fromExpress = await viaExpress.facts(described);
    const fromHono = await viaHono.facts(described);
    expect(fromHono).toEqual(fromExpress);
    expect(fromExpress).toMatchObject({
      peerAddress: '::ffff:127.0.0.1',
      connectionEncrypted: true,
      user: described.user,
      agentIdentity: described.agentIdentity,
    });
    expect(fromExpress.headers.host).toBe('localhost:4242');
  });

  it('report no identity when no middleware resolved one', async () => {
    for (const adapter of REQUEST_FACTS_ADAPTERS) {
      const facts = await adapter.facts({ headers: {} });
      expect(facts.user).toBeUndefined();
      expect(facts.agentIdentity).toBeUndefined();
      expect(facts.connectionEncrypted).toBe(false);
      expect(facts.managedIngress).toBe(false);
    }
  });
});
