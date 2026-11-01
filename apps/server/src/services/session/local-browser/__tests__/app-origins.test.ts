import { describe, expect, it, vi } from 'vitest';

const live = vi.hoisted(() => ({
  origins: ['https://tunnel.example'],
  localOrigins: ['http://localhost:4242', 'http://127.0.0.1:4241'],
}));
vi.mock('../../../../lib/trusted-origins.js', () => ({
  getStaticLocalOrigins: () => live.localOrigins,
  resolveTrustedOrigins: () => live.origins,
}));
vi.mock('node:os', () => ({
  hostname: () => 'fixture.local',
  networkInterfaces: () => ({
    en0: [
      { address: '192.168.1.20', family: 'IPv4' },
      { address: '2001:db8::1', family: 'IPv6' },
    ],
  }),
}));

import { isLocalBrowserAppUrl, localBrowserAppOrigins } from '../app-origins.js';

describe('live DorkOS browser origin refusal set', () => {
  it('includes both listeners, IPv6, local names and network addresses', () => {
    const origins = localBrowserAppOrigins();
    for (const origin of [
      'http://[::1]:4242',
      'http://localhost:4241',
      'https://127.0.0.1:4242',
      'http://fixture.local:4242',
      'http://192.168.1.20:4242',
      'http://[2001:db8::1]:4242',
      'https://tunnel.example',
    ])
      expect(isLocalBrowserAppUrl(origin + '/connections', origins)).toBe(true);
  });

  it('picks up tunnel changes without restarting', () => {
    const prior = live.origins;
    try {
      live.origins = ['https://new-tunnel.example'];
      expect(localBrowserAppOrigins()).toContain('https://new-tunnel.example');
      expect(localBrowserAppOrigins()).not.toContain('https://tunnel.example');
    } finally {
      live.origins = prior;
    }
  });

  it('preserves the listener port when URL normalization drops a default port', () => {
    const prior = live.localOrigins;
    try {
      live.localOrigins = ['http://localhost:80'];
      const origins = localBrowserAppOrigins();
      expect(isLocalBrowserAppUrl('https://localhost:80', origins)).toBe(true);
      expect(isLocalBrowserAppUrl('https://localhost:443', origins)).toBe(false);
    } finally {
      live.localOrigins = prior;
    }
  });

  it.each([
    'http://LOCALHOST:4242/path',
    'http://127.1:4242/path',
    'http://127.0.0.2:4242/path',
    'http://2130706433:4242/path',
    'http://[::ffff:127.0.0.1]:4242/path',
    'http://[::ffff:192.168.1.20]:4242/path',
    'http://localhost.:4242/path',
    'http://user:password@localhost:4242/path',
  ])('normalizes %s before comparing', (url) => {
    expect(isLocalBrowserAppUrl(url, localBrowserAppOrigins())).toBe(true);
  });

  it.each([
    'http://localhost:9000/',
    'http://localhost.example:4242/',
    'https://tunnel.example.evil.test/',
    'https://tunnel.example@other.test/',
    'https://other.test/?next=http://localhost:4242',
    'not a URL',
    'data:text/plain,hello',
  ])('does not confuse %s with the app', (url) => {
    expect(isLocalBrowserAppUrl(url, localBrowserAppOrigins())).toBe(false);
  });

  it('keeps valid refusals when one dynamic origin is malformed', () => {
    expect(isLocalBrowserAppUrl('http://localhost:4242', ['bad', 'http://localhost:4242'])).toBe(
      true
    );
  });
});
