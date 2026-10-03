import { describe, it, expect } from 'vitest';
import { frameRequest, type RawRequest } from '../framing.js';
import { brokerLimits } from '../limits.js';
import { BrokerError } from '../errors.js';
const limits = brokerLimits();
const raw = (headers: string[] = [], target = 'http://example.test/path?q=1'): RawRequest => ({
  method: 'POST',
  target,
  rawHeaders: ['Host', 'example.test', 'Proxy-Authorization', 'Bearer fixture-secret', ...headers],
  head: new Uint8Array(),
});
describe('raw HTTP boundaries before effect', () => {
  it('preserves approved site credentials but removes every proxy and nominated hop', () => {
    const parsed = frameRequest(
      raw([
        'Authorization',
        'Bearer site-secret',
        'Cookie',
        'fixture-cookie',
        'Connection',
        'remove-me',
        'Remove-Me',
        'private-value',
      ]),
      limits
    );
    expect(parsed.path).toBe('/path?q=1');
    expect(parsed.headers.authorization).toBe('Bearer site-secret');
    expect(parsed.headers.cookie).toBe('fixture-cookie');
    expect(JSON.stringify(parsed.headers)).not.toContain('fixture-secret');
    expect(parsed.headers['remove-me']).toBeUndefined();
  });
  it.each(
    [
      ['Host', 'example.test'],
      ['Proxy-Authorization', 'Bearer other'],
      ['Content-Length', '1', 'Content-Length', '1'],
      ['Transfer-Encoding', 'chunked', 'Transfer-Encoding', 'chunked'],
      ['Content-Length', '1', 'Transfer-Encoding', 'chunked'],
      ['Connection', 'proxy-authorization'],
      ['Expect', '100-continue'],
      ['Bad Header', 'value'],
    ].map((headers) => [headers])
  )('refuses ambiguous raw pairs %j', (headers) => {
    expect(() => frameRequest(raw(headers), limits)).toThrow();
  });
  it.each([
    'http://other.test/',
    'http://u:p@example.test/',
    'http://example.test/#fragment',
    'http://example.test/\\other',
    'https://example.test/',
  ])('refuses retarget or unsupported scheme %s', (target) => {
    expect(() => frameRequest(raw([], target), limits)).toThrow();
  });
  it('accepts single chunked framing for strict Node dechunking, but never a CONNECT body', () => {
    expect(
      frameRequest(raw(['Transfer-Encoding', 'chunked']), limits).headers['transfer-encoding']
    ).toBeUndefined();
    expect(() =>
      frameRequest(
        {
          ...raw(['Transfer-Encoding', 'chunked']),
          method: 'CONNECT',
          target: 'example.test:443',
          rawHeaders: [
            'Host',
            'example.test:443',
            'Proxy-Authorization',
            'Bearer fixture-secret',
            'Transfer-Encoding',
            'chunked',
          ],
        },
        limits
      )
    ).toThrow();
  });
  it('bounds exact raw field count and plus one', () => {
    const tiny = brokerLimits({ headerFields: 2 });
    expect(frameRequest(raw(), tiny).kind).toBe('http');
    expect(() => frameRequest(raw(['X-Foo', 'bar']), tiny)).toThrow('FRAMING_REFUSED');
  });
  it('redacts forged error causes into fixed unavailable', () => {
    const error = new BrokerError('password-secret' as never);
    expect(error.code).toBe('UNAVAILABLE');
    expect(error.message).not.toContain('password-secret');
  });
});
