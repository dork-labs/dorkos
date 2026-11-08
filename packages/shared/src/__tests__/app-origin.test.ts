import { describe, expect, it } from 'vitest';
import {
  appHostKey,
  cookieReachesApp,
  isAppHostOrigin,
  localAppHosts,
  withoutAppOrigin,
} from '../app-origin.js';

const hosts = localAppHosts('mac.lan', {
  en0: [
    { address: '192.168.1.20', family: 'IPv4' },
    { address: '2001:db8::1', family: 'IPv6' },
    { address: 'fe80::1%en0', family: 'IPv6' },
  ],
});

describe('appHostKey', () => {
  it.each([
    ['LOCALHOST.', 'localhost'],
    ['127.0.0.2', 'localhost'],
    ['[::1]', 'localhost'],
    ['::1', 'localhost'],
    ['[::ffff:7f00:1]', 'localhost'],
    ['app.localhost', 'localhost'],
    ['x.localtest.me', 'localhost'],
    ['127-0-0-1.nip.io', 'localhost'],
    ['2001:db8::1', '[2001:db8::1]'],
    ['GitHub.com', 'github.com'],
  ])('reads %s as %s', (host, key) => {
    expect(appHostKey(host)).toBe(key);
  });
});

describe('localAppHosts', () => {
  it('names loopback, the computer, its Bonjour name and its addresses, never a link-local scope', () => {
    expect(hosts).toEqual([
      'localhost',
      '127.0.0.1',
      '[::1]',
      '0.0.0.0',
      'mac.lan',
      'mac.local',
      '192.168.1.20',
      '[2001:db8::1]',
    ]);
  });
});

describe('cookieReachesApp', () => {
  it.each([
    'localhost',
    '127.0.0.1',
    '[::1]',
    '.localhost',
    'mac.lan',
    '.lan',
    'mac.local',
    '192.168.1.20',
    '[2001:db8::1]',
  ])('drops a cookie on %s', (domain) => {
    expect(cookieReachesApp(domain, hosts)).toBe(true);
  });

  it.each(['github.com', '.github.com', 'other.lan', 'lan', '192.168.1.21', ''])(
    'keeps a cookie on %s',
    (domain) => {
      expect(cookieReachesApp(domain, hosts)).toBe(false);
    }
  );
});

describe('isAppHostOrigin', () => {
  it('matches DorkOS’s hosts on any port and nothing else', () => {
    expect(isAppHostOrigin('http://localhost:4242', hosts)).toBe(true);
    expect(isAppHostOrigin('https://127.0.0.1:9999', hosts)).toBe(true);
    expect(isAppHostOrigin('http://mac.local:6241', hosts)).toBe(true);
    expect(isAppHostOrigin('https://github.com', hosts)).toBe(false);
    expect(isAppHostOrigin('file:///etc', hosts)).toBe(false);
    expect(isAppHostOrigin('not a url', hosts)).toBe(false);
  });
});

describe('withoutAppOrigin', () => {
  it('removes DorkOS’s cookies and page storage, keeps the rest, and counts both', () => {
    const result = withoutAppOrigin(
      {
        cookies: [{ domain: 'localhost' }, { domain: '.lan' }, { domain: 'github.com' }],
        origins: [{ origin: 'http://localhost:4242' }, { origin: 'https://github.com' }],
      },
      hosts
    );
    expect(result.state.cookies).toEqual([{ domain: 'github.com' }]);
    expect(result.state.origins).toEqual([{ origin: 'https://github.com' }]);
    expect(result.removedCookies).toBe(2);
    expect(result.removedOrigins).toBe(1);
  });
});
