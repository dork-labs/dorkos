import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { forwardedClientAddress, nodeTransportFacts } from '../request-facts.js';

/** A header shape, and the address Express's `req.ip` reported for it from peer `192.0.2.10`. */
const FORWARDED_FOR_SHAPES: Array<[string, string | undefined, string]> = [
  ['no header', undefined, '192.0.2.10'],
  ['one entry', '203.0.113.1', '203.0.113.1'],
  ['a chain: the last entry is the hop the peer saw', '203.0.113.1, 198.51.100.9', '198.51.100.9'],
  ['padded entries', '  203.0.113.1 ,   198.51.100.9   ', '198.51.100.9'],
  ['a trailing comma', '203.0.113.1,', '203.0.113.1'],
  ['only commas and spaces', ' , ,', '192.0.2.10'],
  ['a tab kept', '203.0.113.1,\t198.51.100.9', '\t198.51.100.9'],
];

/** A raw request with just the parts the facts read. */
function incoming(
  headers: Record<string, string | string[]>,
  socket: { remoteAddress?: string; encrypted?: boolean }
): Pick<IncomingMessage, 'headers' | 'socket'> {
  return { headers, socket: socket as IncomingMessage['socket'] };
}

describe('forwardedClientAddress', () => {
  it.each(FORWARDED_FOR_SHAPES)('matches Express req.ip: %s', (_name, header, expected) => {
    expect(forwardedClientAddress(header, '192.0.2.10')).toBe(expected);
  });

  it('is nothing when there is neither a header nor a peer', () => {
    expect(forwardedClientAddress(undefined, undefined)).toBeUndefined();
  });
});

describe('nodeTransportFacts', () => {
  it('describes the connection and its headers', () => {
    const facts = nodeTransportFacts(
      incoming(
        { host: 'localhost:4242', 'x-forwarded-for': '203.0.113.1' },
        { remoteAddress: '127.0.0.1', encrypted: true }
      ),
      'POST'
    );
    expect(facts).toEqual({
      headers: { host: 'localhost:4242', 'x-forwarded-for': '203.0.113.1' },
      peerAddress: '127.0.0.1',
      forwardedAddress: '203.0.113.1',
      connectionEncrypted: true,
      method: 'POST',
    });
  });

  it('joins a repeated forwarded header and leaves the method out when unknown', () => {
    const facts = nodeTransportFacts(
      incoming({ 'x-forwarded-for': ['203.0.113.1', '198.51.100.9'] }, { remoteAddress: '::1' })
    );
    expect(facts.forwardedAddress).toBe('198.51.100.9');
    expect(facts.connectionEncrypted).toBe(false);
    expect('method' in facts).toBe(false);
  });
});
