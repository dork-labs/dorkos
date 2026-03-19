import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    start: vi.fn(),
    stop: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    status: {
      enabled: false, connected: false, url: null, port: null, startedAt: null,
      authEnabled: false, tokenConfigured: false, domain: null,
    },
  },
}));

const defaultTunnelStatus = {
  enabled: false,
  connected: false,
  url: null,
  port: null,
  startedAt: null,
  authEnabled: false,
  tokenConfigured: false,
  domain: null,
};

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn(),
    set: vi.fn(),
  },
}));

import request from 'supertest';
import { createApp } from '../../app.js';
import { tunnelManager } from '../../services/core/tunnel-manager.js';
import { configManager } from '../../services/core/config-manager.js';

const app = createApp();

/** Typed helper to mock configManager.get with arbitrary return values. */
const mockConfigGet = vi.mocked(configManager.get) as unknown as ReturnType<typeof vi.fn>;

/** Typed helper to mock tunnelManager.start with arbitrary implementations. */
const mockTunnelStart = vi.mocked(tunnelManager.start) as unknown as ReturnType<typeof vi.fn>;

describe('Tunnel Route', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NGROK_AUTHTOKEN;
    delete process.env.TUNNEL_PORT;
    delete process.env.DORKOS_PORT;
    delete process.env.VITE_PORT;
    // Ensure non-production (dev mode) by default so tunnel resolves to Vite port
    process.env.NODE_ENV = 'test';

    // Reset status to default
    (tunnelManager as unknown as Record<string, unknown>).status = { ...defaultTunnelStatus };
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  describe('POST /api/tunnel/start', () => {
    it('returns 200 with URL when NGROK_AUTHTOKEN env var is set and start succeeds', async () => {
      process.env.NGROK_AUTHTOKEN = 'test-token-123';
      mockConfigGet.mockReturnValue(undefined);
      mockTunnelStart.mockImplementation(async () => {
        (tunnelManager as unknown as Record<string, unknown>).status = {
          enabled: true,
          connected: true,
          url: 'https://test.ngrok.io',
          port: 4241,
          startedAt: new Date().toISOString(),
        };
        return 'https://test.ngrok.io';
      });

      const res = await request(app).post('/api/tunnel/start');

      expect(res.status).toBe(200);
      expect(res.body.url).toBe('https://test.ngrok.io');
      // In dev (NODE_ENV !== 'production'), defaults to Vite's port (4241)
      expect(tunnelManager.start).toHaveBeenCalledWith(
        expect.objectContaining({ authtoken: 'test-token-123', port: 4241 }),
      );
    });

    it('uses Express port in production mode', async () => {
      process.env.NGROK_AUTHTOKEN = 'test-token-123';
      process.env.NODE_ENV = 'production';
      mockConfigGet.mockReturnValue(undefined);
      mockTunnelStart.mockImplementation(async () => {
        (tunnelManager as unknown as Record<string, unknown>).status = {
          enabled: true,
          connected: true,
          url: 'https://test.ngrok.io',
          port: 4242,
          startedAt: new Date().toISOString(),
        };
        return 'https://test.ngrok.io';
      });

      const res = await request(app).post('/api/tunnel/start');

      expect(res.status).toBe(200);
      expect(tunnelManager.start).toHaveBeenCalledWith(
        expect.objectContaining({ authtoken: 'test-token-123', port: 4242 }),
      );
    });

    it('returns 400 when no auth token is configured', async () => {
      mockConfigGet.mockReturnValue(undefined);

      const res = await request(app).post('/api/tunnel/start');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('No ngrok auth token configured');
      expect(tunnelManager.start).not.toHaveBeenCalled();
    });

    it('returns 409 when tunnel is already running', async () => {
      (tunnelManager as unknown as Record<string, unknown>).status = {
        ...defaultTunnelStatus,
        connected: true,
        url: 'https://already-running.ngrok.io',
      };

      const res = await request(app).post('/api/tunnel/start');

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('Tunnel is already running');
      expect(res.body.url).toBe('https://already-running.ngrok.io');
      expect(tunnelManager.start).not.toHaveBeenCalled();
    });

    it('returns 500 when tunnelManager.start() throws', async () => {
      process.env.NGROK_AUTHTOKEN = 'test-token-123';
      mockConfigGet.mockReturnValue(undefined);
      mockTunnelStart.mockRejectedValue(new Error('Connection failed'));

      const res = await request(app).post('/api/tunnel/start');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Connection failed');
    });

    it('persists tunnel.enabled: true in config after successful start', async () => {
      process.env.NGROK_AUTHTOKEN = 'test-token-123';
      mockConfigGet.mockReturnValue({
        enabled: false,
        domain: 'my.domain.io',
        authtoken: null,
        auth: null,
      });
      mockTunnelStart.mockImplementation(async () => {
        (tunnelManager as unknown as Record<string, unknown>).status = {
          enabled: true,
          connected: true,
          url: 'https://my.domain.io',
          port: 4242,
          startedAt: new Date().toISOString(),
        };
        return 'https://my.domain.io';
      });

      await request(app).post('/api/tunnel/start');

      expect(configManager.set).toHaveBeenCalledWith(
        'tunnel',
        expect.objectContaining({ enabled: true }),
      );
    });
  });

  describe('GET /api/tunnel/status', () => {
    it('returns current tunnel status', async () => {
      (tunnelManager as unknown as Record<string, unknown>).status = {
        ...defaultTunnelStatus,
        enabled: true,
        connected: true,
        url: 'https://abc.ngrok.io',
      };

      const res = await request(app).get('/api/tunnel/status');

      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
      expect(res.body.connected).toBe(true);
      expect(res.body.url).toBe('https://abc.ngrok.io');
    });

    it('returns default status when tunnel is not started', async () => {
      const res = await request(app).get('/api/tunnel/status');

      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(false);
      expect(res.body.connected).toBe(false);
    });
  });

  describe('POST /api/tunnel/stop', () => {
    it('returns 200 with { ok: true } when stop succeeds', async () => {
      vi.mocked(tunnelManager.stop).mockResolvedValue(undefined);
      mockConfigGet.mockReturnValue({
        enabled: true,
        domain: null,
        authtoken: null,
        auth: null,
      });

      const res = await request(app).post('/api/tunnel/stop');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(tunnelManager.stop).toHaveBeenCalled();
    });

    it('persists tunnel.enabled: false in config after successful stop', async () => {
      vi.mocked(tunnelManager.stop).mockResolvedValue(undefined);
      mockConfigGet.mockReturnValue({
        enabled: true,
        domain: 'my.domain.io',
        authtoken: null,
        auth: null,
      });

      await request(app).post('/api/tunnel/stop');

      expect(configManager.set).toHaveBeenCalledWith(
        'tunnel',
        expect.objectContaining({ enabled: false, domain: 'my.domain.io' }),
      );
    });

    it('returns 500 when tunnelManager.stop() throws', async () => {
      vi.mocked(tunnelManager.stop).mockRejectedValue(new Error('Disconnect failed'));
      mockConfigGet.mockReturnValue(undefined);

      const res = await request(app).post('/api/tunnel/stop');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Disconnect failed');
    });
  });
});
