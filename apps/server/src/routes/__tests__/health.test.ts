import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: {
      enabled: false,
      connected: false,
      url: null,
      port: null,
      startedAt: null,
      authEnabled: false,
      tokenConfigured: false,
      domain: null,
    },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
  },
}));

const defaultStatus = {
  enabled: false,
  connected: false,
  url: null,
  port: null,
  startedAt: null,
  authEnabled: false,
  tokenConfigured: false,
  domain: null,
};

import request from 'supertest';
import { createApp } from '../../app.js';
import { tunnelManager } from '../../services/core/tunnel-manager.js';

const app = createApp();

describe('Health Route', () => {
  beforeEach(() => {
    // Reset to disabled state
    (tunnelManager as unknown as Record<string, unknown>).status = { ...defaultStatus };
  });

  it('GET /api/health returns status ok without tunnel field when disabled', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.version).toBe('string');
    expect(res.body.version).toBeTruthy();
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.tunnel).toBeUndefined();
  });

  it('GET /api/health includes tunnel status when enabled and connected', async () => {
    (tunnelManager as unknown as Record<string, unknown>).status = {
      ...defaultStatus,
      enabled: true,
      connected: true,
      url: 'https://test.ngrok.io',
      port: 4242,
      startedAt: '2025-01-01T00:00:00.000Z',
    };

    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.tunnel).toEqual(
      expect.objectContaining({
        enabled: true,
        connected: true,
        url: 'https://test.ngrok.io',
        port: 4242,
        startedAt: '2025-01-01T00:00:00.000Z',
      })
    );
  });

  it('GET /api/health shows disconnected tunnel after stop', async () => {
    (tunnelManager as unknown as Record<string, unknown>).status = {
      ...defaultStatus,
      enabled: true,
      connected: false,
      url: null,
      port: 4242,
      startedAt: '2025-01-01T00:00:00.000Z',
    };

    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.tunnel.connected).toBe(false);
    expect(res.body.tunnel.url).toBeNull();
  });
});
