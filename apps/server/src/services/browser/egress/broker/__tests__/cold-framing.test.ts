import { expect, it } from 'vitest';
import { frameRequest, validateProxyChallenge } from '../framing.js';
import { BROKER_LIMITS } from '../limits.js';

const secret = 'A'.repeat(43);
const basic = (value: string) => `Basic ${Buffer.from(value).toString('base64')}`;
const raw = (auth: readonly string[] = []) => ({
  method: 'GET',
  target: 'http://example.test/path',
  head: new Uint8Array(),
  rawHeaders: ['Host', 'example.test', ...auth],
});

it('accepts only canonical private Basic credentials and strips the exact auth header', () => {
  const request = frameRequest(
    raw(['Proxy-Authorization', basic(`dorkos:${secret}`)]),
    BROKER_LIMITS
  );
  expect(request.credential).toBe(secret);
  expect(request.headers['proxy-authorization']).toBeUndefined();
  expect(request.headers.authorization).toBeUndefined();
  expect(JSON.stringify(request.headers)).not.toContain(secret);
  expect(
    frameRequest(raw(['Proxy-Authorization', `Bearer ${secret}`]), BROKER_LIMITS).credential
  ).toBe(secret);
});

it.each([
  'Basic !!!',
  basic(`wrong:${secret}`),
  basic('dorkos:short'),
  basic(`dorkos:${secret}:suffix`),
  basic(`dorkos:${secret}`) + '=',
  basic(`dorkos:${secret}`) + ' ',
  'Bearer invalid+secret',
  'basic ' + Buffer.from(`dorkos:${secret}`).toString('base64'),
])('refuses malformed or noncanonical proxy authorization (%s)', (auth) => {
  expect(() => frameRequest(raw(['Proxy-Authorization', auth]), BROKER_LIMITS)).toThrow(
    'CREDENTIAL_REFUSED'
  );
});

it('refuses conflicting Basic/Bearer headers and auth nominated by connection', () => {
  expect(() =>
    frameRequest(
      raw([
        'Proxy-Authorization',
        basic(`dorkos:${secret}`),
        'proxy-authorization',
        `Bearer ${secret}`,
      ]),
      BROKER_LIMITS
    )
  ).toThrow('FRAMING_REFUSED');
  expect(() =>
    frameRequest(
      raw(['Proxy-Authorization', basic(`dorkos:${secret}`), 'Connection', 'proxy-authorization']),
      BROKER_LIMITS
    )
  ).toThrow('FRAMING_REFUSED');
});

it('validates challenges through the same strict raw framing without yielding a credential', () => {
  expect(validateProxyChallenge(raw(), BROKER_LIMITS)).toBeUndefined();
  expect(() =>
    validateProxyChallenge(raw(['Proxy-Authorization', 'Basic malformed']), BROKER_LIMITS)
  ).toThrow('CREDENTIAL_REFUSED');
  expect(() =>
    validateProxyChallenge(raw(['Content-Length', '1', 'Content-Length', '2']), BROKER_LIMITS)
  ).toThrow('FRAMING_REFUSED');
  expect(() =>
    validateProxyChallenge({ ...raw(), target: 'http://example.test/path#fragment' }, BROKER_LIMITS)
  ).toThrow('FRAMING_REFUSED');
});
