import { describe, expect, it, vi } from 'vitest';

const live = vi.hoisted(() => ({
  origins: ['https://tunnel.example'],
  localOrigins: ['http://localhost:4242', 'http://127.0.0.1:4241'],
  tunnelHosts: ['tunnel.example'],
  env: {
    DORKOS_TRUSTED_HOSTS: undefined as string | undefined,
    DORKOS_TLS_PORT: undefined as number | undefined,
  },
}));
vi.mock('../../../../env.js', () => ({ env: live.env }));
vi.mock('../../../../lib/trusted-origins.js', () => ({
  getStaticLocalOrigins: () => live.localOrigins,
  getTunnelHosts: () => live.tunnelHosts,
  isLoopbackHost: (host: string) => ['localhost', '127.0.0.1', '::1'].includes(host),
  resolveAuthTrustedOrigins: () => live.origins,
}));
vi.mock('../../../../middleware/host-guard.js', () => ({
  parseTrustedHosts: (raw: string | undefined) => (raw ? raw.split(',') : []),
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

  it('refuses an origin the person listed in DORKOS_CORS_ORIGIN, which the auth list carries', () => {
    const prior = live.origins;
    try {
      live.origins = [...prior, 'https://proxy.example'];
      expect(isLocalBrowserAppUrl('https://proxy.example/', localBrowserAppOrigins())).toBe(true);
    } finally {
      live.origins = prior;
    }
  });

  it.each([
    'https://mac.tail1234.ts.net/',
    'http://mac.tail1234.ts.net/',
    'https://mac.tail1234.ts.net:8443/connections',
    'http://dorkos.home.arpa:9000/',
    'view-source:https://mac.tail1234.ts.net/',
  ])('refuses %s, a host in DORKOS_TRUSTED_HOSTS, on any scheme or port', (url) => {
    live.env.DORKOS_TRUSTED_HOSTS = 'mac.tail1234.ts.net,dorkos.home.arpa';
    try {
      expect(isLocalBrowserAppUrl(url, localBrowserAppOrigins())).toBe(true);
    } finally {
      live.env.DORKOS_TRUSTED_HOSTS = undefined;
    }
  });

  it('keeps other localhost ports usable when localhost is a trusted host', () => {
    live.env.DORKOS_TRUSTED_HOSTS = 'localhost';
    try {
      expect(isLocalBrowserAppUrl('http://localhost:9000/', localBrowserAppOrigins())).toBe(false);
    } finally {
      live.env.DORKOS_TRUSTED_HOSTS = undefined;
    }
  });

  it('refuses the TLS listener port on local names', () => {
    live.env.DORKOS_TLS_PORT = 4443;
    try {
      expect(isLocalBrowserAppUrl('https://localhost:4443/', localBrowserAppOrigins())).toBe(true);
    } finally {
      live.env.DORKOS_TLS_PORT = undefined;
    }
  });

  it('refuses the tunnel over plain http too', () => {
    expect(isLocalBrowserAppUrl('http://tunnel.example/', localBrowserAppOrigins())).toBe(true);
  });

  it('refuses the Bonjour name built from the computer name', () => {
    expect(isLocalBrowserAppUrl('http://fixture.local:4242/', localBrowserAppOrigins())).toBe(true);
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
    'http://0.0.0.0:4242/path',
    'http://[::]:4242/path',
    'view-source:http://localhost:4242/path',
    'view-source:https://tunnel.example/path',
    'blob:http://localhost:4242/0b1c',
    'http://0x7f.1:4242/path',
    'http://0177.0.0.1:4242/path',
    'http://foo.localhost:4242/path',
    'http://localhost..:4242/path',
    'http://127.0.0.1.nip.io:4242/path',
    'http://app.127-0-0-1.sslip.io:4242/path',
    'http://localtest.me:4242/path',
    'http://[::7f00:1]:4242/path',
    'http://[::127.0.0.1]:4242/path',
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
    'view-source:https://other.test/',
    'http://foo.localhost:9000/',
    'http://notlocalhost:4242/',
    'http://8.8.8.8.nip.io:4242/',
    'http://my127.0.0.1.nip.io.evil.test:4242/',
  ])('does not confuse %s with the app', (url) => {
    expect(isLocalBrowserAppUrl(url, localBrowserAppOrigins())).toBe(false);
  });

  it('keeps valid refusals when one dynamic origin is malformed', () => {
    expect(isLocalBrowserAppUrl('http://localhost:4242', ['bad', 'http://localhost:4242'])).toBe(
      true
    );
  });
});
