import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestListener } from 'node:http';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';

// Mutable stand-ins so each test can move one fact at a time. The middleware
// reads all three per request, which is exactly the behaviour under test.
const mockEnv = vi.hoisted(() => ({
  DORKOS_ALLOW_INSECURE_BIND: false,
  DORKOS_TRUSTED_HOSTS: undefined as string | undefined,
}));
const mockTunnelManager = vi.hoisted(() => ({ status: { url: null as string | null } }));
const mockAuthConfig = vi.hoisted(() => ({ enabled: false }));

vi.mock('../../env.js', () => ({ env: mockEnv }));
vi.mock('../../services/core/tunnel-manager.js', () => ({ tunnelManager: mockTunnelManager }));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'auth' ? mockAuthConfig : undefined),
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  isHostAllowed,
  parseTrustedHosts,
  refuseStandaloneDocTokenHost,
  refuseUntrustedHost,
} from '../host-guard.js';
import { setLanTrust } from '../../services/core/lan-access/lan-trust.js';
import { createApiApp } from '../../http/api-chain.js';
import { frontDoorListener } from '../../http/front-door.js';
import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
import { logger } from '../../lib/logger.js';

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

/**
 * The real chain (`http/api-chain.ts`): the guard sits in front of `/api`,
 * ahead of the body parser, so a rejected request never has its payload read.
 */
function createTestApp(): RequestListener {
  const app = createApiApp({ admission: new MainRequestAdmission() });
  app.post('/api/sessions/:id/messages', (c) => c.json({ accepted: true }, 202));
  app.get('/api/health', (c) => c.json({ status: 'ok' }));
  return frontDoorListener(app);
}

describe('the host guard in the chain', () => {
  let app: RequestListener;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.DORKOS_ALLOW_INSECURE_BIND = false;
    mockEnv.DORKOS_TRUSTED_HOSTS = undefined;
    mockTunnelManager.status.url = null;
    mockAuthConfig.enabled = false;
    app = createTestApp();

    fixtureTarget.mount(app);
  });

  describe('loopback hosts', () => {
    it.each(['localhost:4242', '127.0.0.1:4242', '[::1]:4242', 'localhost', '127.0.0.1'])(
      'allows Host: %s',
      async (host) => {
        const res = await request(fixtureServer).get('/api/health').set('Host', host);
        expect(res.status).toBe(200);
      }
    );

    it('ignores the port, so the Vite dev proxy and ssh -L forwards pass', async () => {
      const res = await request(fixtureServer).get('/api/health').set('Host', 'localhost:4300');
      expect(res.status).toBe(200);
    });

    it('is case-insensitive', async () => {
      const res = await request(fixtureServer).get('/api/health').set('Host', 'LOCALHOST:4242');
      expect(res.status).toBe(200);
    });
  });

  describe('Wi-Fi access (DOR-2930)', () => {
    it('answers this computer’s .local name only while Wi-Fi access is open', async () => {
      setLanTrust({ port: 4242, names: ['studio.local'], secureCookies: false });
      try {
        const open = await request(fixtureServer)
          .get('/api/health')
          .set('Host', 'studio.local:4242');
        expect(open.status).toBe(200);
      } finally {
        setLanTrust(null);
      }
      const closed = await request(fixtureServer)
        .get('/api/health')
        .set('Host', 'studio.local:4242');
      expect(closed.status).toBe(403);
      expect(closed.body.code).toBe('HOST_NOT_ALLOWED');
    });
  });

  describe('untrusted hosts', () => {
    it('rejects a rebound host with 403 before the body is parsed', async () => {
      const res = await request(fixtureServer)
        .post('/api/sessions/abc/messages')
        .set('Host', 'evil.com:4242')
        .send({ prompt: 'rm -rf /', cwd: '/' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('HOST_NOT_ALLOWED');
    });

    it('names DORKOS_TRUSTED_HOSTS in the error so the fix reads in one line', async () => {
      const res = await request(fixtureServer).get('/api/health').set('Host', 'evil.com');
      expect(res.body.error).toContain('DORKOS_TRUSTED_HOSTS');
    });

    it('does not echo the allowlist back to the caller', async () => {
      mockEnv.DORKOS_TRUSTED_HOSTS = 'dorkos.example.com';
      const res = await request(fixtureServer).get('/api/health').set('Host', 'evil.com');
      expect(res.body.error).not.toContain('dorkos.example.com');
      expect(res.body.error).not.toContain('localhost');
    });

    it('logs the offending host at warn', async () => {
      await request(fixtureServer).get('/api/health').set('Host', 'evil.com');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('untrusted Host'),
        expect.objectContaining({ host: 'evil.com' })
      );
    });

    it('rejects a request with no Host header (HTTP/1.1 requires one)', async () => {
      // supertest always sets Host, so ask the guard's decision directly.
      expect(refuseUntrustedHost(undefined, 'GET', '/api/health')).toMatchObject({
        code: 'HOST_NOT_ALLOWED',
      });
    });
  });

  describe('DORKOS_TRUSTED_HOSTS', () => {
    it('allows a configured host name', async () => {
      mockEnv.DORKOS_TRUSTED_HOSTS = 'dorkos.example.com';
      const res = await request(fixtureServer).get('/api/health').set('Host', 'dorkos.example.com');
      expect(res.status).toBe(200);
    });

    it('allows a configured host on any port', async () => {
      mockEnv.DORKOS_TRUSTED_HOSTS = 'dorkos.example.com';
      const res = await request(fixtureServer)
        .get('/api/health')
        .set('Host', 'dorkos.example.com:8443');
      expect(res.status).toBe(200);
    });

    it('accepts a comma-separated list with stray whitespace and mixed case', async () => {
      mockEnv.DORKOS_TRUSTED_HOSTS = ' first.example.com , DorkOS.Internal ';
      const res = await request(fixtureServer).get('/api/health').set('Host', 'dorkos.internal');
      expect(res.status).toBe(200);
    });

    it('still rejects a host that is not on the list', async () => {
      mockEnv.DORKOS_TRUSTED_HOSTS = 'dorkos.example.com';
      const res = await request(fixtureServer).get('/api/health').set('Host', 'evil.com');
      expect(res.status).toBe(403);
    });
  });

  describe('tunnel host', () => {
    it('allows the live tunnel host', async () => {
      mockTunnelManager.status.url = 'https://my-tunnel.ngrok-free.app';
      const res = await request(fixtureServer)
        .get('/api/health')
        .set('Host', 'my-tunnel.ngrok-free.app');
      expect(res.status).toBe(200);
    });

    it('rejects a tunnel-shaped host when no tunnel is connected', async () => {
      const res = await request(fixtureServer)
        .get('/api/health')
        .set('Host', 'my-tunnel.ngrok-free.app');
      expect(res.status).toBe(403);
    });
  });

  describe('skip conditions', () => {
    it('skips entirely when login is enabled', async () => {
      mockAuthConfig.enabled = true;
      const res = await request(fixtureServer).get('/api/health').set('Host', 'evil.com');
      expect(res.status).toBe(200);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('skips entirely when DORKOS_ALLOW_INSECURE_BIND is set (Docker)', async () => {
      mockEnv.DORKOS_ALLOW_INSECURE_BIND = true;
      const res = await request(fixtureServer).get('/api/health').set('Host', 'anything.internal');
      expect(res.status).toBe(200);
    });
  });
});

describe('standalone Doc token hosts', () => {
  it('reads live Wi-Fi trust without inheriting the login-enabled Host waiver', () => {
    mockEnv.DORKOS_ALLOW_INSECURE_BIND = false;
    mockEnv.DORKOS_TRUSTED_HOSTS = undefined;
    mockTunnelManager.status.url = null;
    mockAuthConfig.enabled = true;
    setLanTrust(null);
    try {
      expect(refuseStandaloneDocTokenHost('studio.local:4242')).toMatchObject({
        code: 'HOST_NOT_ALLOWED',
      });
      setLanTrust({ port: 4242, names: ['studio.local'], secureCookies: false });
      expect(refuseStandaloneDocTokenHost('studio.local:4242')).toBeNull();
      expect(refuseStandaloneDocTokenHost('evil.com:4242')).toMatchObject({
        code: 'HOST_NOT_ALLOWED',
      });
      setLanTrust({ port: 4242, names: ['office.local'], secureCookies: false });
      expect(refuseStandaloneDocTokenHost('studio.local:4242')).toMatchObject({
        code: 'HOST_NOT_ALLOWED',
      });
      expect(refuseStandaloneDocTokenHost('office.local:4242')).toBeNull();
      setLanTrust(null);
      expect(refuseStandaloneDocTokenHost('office.local:4242')).toMatchObject({
        code: 'HOST_NOT_ALLOWED',
      });
    } finally {
      setLanTrust(null);
      mockAuthConfig.enabled = false;
    }
  });
});

describe('parseTrustedHosts', () => {
  it('returns an empty list when unset', () => {
    expect(parseTrustedHosts(undefined)).toEqual([]);
    expect(parseTrustedHosts('')).toEqual([]);
  });

  it('trims, lower-cases, and drops empty entries', () => {
    expect(parseTrustedHosts(' A.example.com ,, b.example.com,')).toEqual([
      'a.example.com',
      'b.example.com',
    ]);
  });
});

describe('isHostAllowed', () => {
  const base = {
    trustedHosts: [] as readonly string[],
    tunnelHosts: [] as readonly string[],
    lanHosts: [] as readonly string[],
  };

  it('rejects a missing host name', () => {
    expect(isHostAllowed({ ...base, hostname: null })).toBe(false);
  });

  it('does not treat a non-loopback host as loopback by prefix', () => {
    expect(isHostAllowed({ ...base, hostname: 'localhost.evil.com' })).toBe(false);
    expect(isHostAllowed({ ...base, hostname: '127.0.0.1.evil.com' })).toBe(false);
  });

  it('matches the tunnel host exactly', () => {
    expect(isHostAllowed({ ...base, hostname: 'x.ngrok.app', tunnelHosts: ['x.ngrok.app'] })).toBe(
      true
    );
    expect(isHostAllowed({ ...base, hostname: 'y.ngrok.app', tunnelHosts: ['x.ngrok.app'] })).toBe(
      false
    );
  });

  it('answers to every managed hostname, and to nothing that is no longer served', () => {
    const tunnelHosts = ['a.example.dev', 'custom.example.com'];
    expect(isHostAllowed({ ...base, hostname: 'a.example.dev', tunnelHosts })).toBe(true);
    expect(isHostAllowed({ ...base, hostname: 'custom.example.com', tunnelHosts })).toBe(true);
    expect(isHostAllowed({ ...base, hostname: 'b.example.dev', tunnelHosts })).toBe(false);
  });

  it('answers to this computer’s own Wi-Fi names while Wi-Fi access is open (DOR-2930)', () => {
    const lanHosts = ['studio.local', '192.168.1.20'];
    expect(isHostAllowed({ ...base, hostname: 'studio.local', lanHosts })).toBe(true);
    expect(isHostAllowed({ ...base, hostname: '192.168.1.20', lanHosts })).toBe(true);
    // Another machine's name or address on the same network is not this one.
    expect(isHostAllowed({ ...base, hostname: 'printer.local', lanHosts })).toBe(false);
    expect(isHostAllowed({ ...base, hostname: '192.168.1.21', lanHosts })).toBe(false);
    // Closed: the same names are strangers again.
    expect(isHostAllowed({ ...base, hostname: 'studio.local' })).toBe(false);
  });
});
