import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn(),
    set: vi.fn(),
  },
}));

import request from 'supertest';
import { createApp } from '../../app.js';
import { env } from '../../env.js';
import { tunnelManager } from '../../services/core/tunnel-manager.js';

const app = createApp();

describe('CORS with tunnel origin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DORKOS_CORS_ORIGIN;
  });

  it('accepts requests from localhost origins', async () => {
    const origin = `http://localhost:${env.DORKOS_PORT}`;
    const res = await request(app)
      .get('/api/health')
      .set('Origin', origin);

    expect(res.headers['access-control-allow-origin']).toBe(origin);
  });

  it('rejects requests from unknown origins', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'https://evil.example.com');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('accepts requests from tunnel origin when tunnel is connected', async () => {
    (tunnelManager as unknown as Record<string, unknown>).status = {
      enabled: true,
      connected: true,
      url: 'https://abc123.ngrok-free.app',
      port: 4241,
      startedAt: new Date().toISOString(),
      authEnabled: false,
      tokenConfigured: true,
      domain: null,
    };

    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'https://abc123.ngrok-free.app');

    expect(res.headers['access-control-allow-origin']).toBe('https://abc123.ngrok-free.app');
  });

  it('rejects tunnel origin when tunnel is disconnected', async () => {
    (tunnelManager as unknown as Record<string, unknown>).status = {
      enabled: false, connected: false, url: null, port: null, startedAt: null,
      authEnabled: false, tokenConfigured: false, domain: null,
    };

    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'https://abc123.ngrok-free.app');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows requests with no origin (server-to-server)', async () => {
    const res = await request(app).get('/api/health');

    expect(res.status).not.toBe(403);
  });
});
