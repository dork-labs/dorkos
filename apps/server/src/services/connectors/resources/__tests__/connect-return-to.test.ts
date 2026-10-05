import { describe, expect, it } from 'vitest';
import { resolveConnectReturnTo } from '../connect-return-to.js';

const SERVED = ['http://localhost:4242', 'http://127.0.0.1:4242', 'https://abc.ngrok.app'];

describe('resolveConnectReturnTo', () => {
  it('keeps the app’s own address with the Connections route', () => {
    expect(resolveConnectReturnTo('http://localhost:4242/connections', SERVED)).toBe(
      'http://localhost:4242/connections'
    );
    expect(resolveConnectReturnTo('http://127.0.0.1:4242/connections/', SERVED)).toBe(
      'http://127.0.0.1:4242/connections'
    );
  });

  it('keeps the live tunnel address', () => {
    expect(resolveConnectReturnTo('https://abc.ngrok.app/connections', SERVED)).toBe(
      'https://abc.ngrok.app/connections'
    );
  });

  it('keeps a dorkos: link to a route the desktop app handles', () => {
    expect(resolveConnectReturnTo('dorkos://connections', SERVED)).toBe('dorkos://connections');
    expect(resolveConnectReturnTo('dorkos://Connections/', SERVED)).toBe('dorkos://connections');
  });

  it('drops the query and fragment rather than forwarding them', () => {
    expect(resolveConnectReturnTo('http://localhost:4242/connections?x=1#y', SERVED)).toBe(
      'http://localhost:4242/connections'
    );
  });

  it.each([
    ['another site', 'https://evil.example/connections'],
    ['javascript:', 'javascript:alert(1)'],
    ['a scheme-relative link', '//evil.example/connections'],
    ['a relative path', '/connections'],
    ['userinfo before another host', 'http://localhost:4242@evil.example/connections'],
    ['userinfo on the app’s own host', 'http://user:pass@localhost:4242/connections'],
    ['the right host on another port', 'http://localhost:9999/connections'],
    ['https where only http is served', 'https://localhost:4242/connections'],
    ['a route the app does not have', 'http://localhost:4242/settings'],
    ['a dorkos: link to an unknown route', 'dorkos://evil'],
    ['a dorkos: link with a path', 'dorkos://connections/../session'],
    ['a dorkos: link with userinfo', 'dorkos://x@connections'],
    ['a data: link', 'data:text/html,hi'],
    ['an empty string', ''],
    ['an oversize value', `http://localhost:4242/connections?${'a'.repeat(2048)}`],
    ['not a string', 42],
  ])('drops %s', (_label, raw) => {
    expect(resolveConnectReturnTo(raw, SERVED)).toBeUndefined();
  });
});
