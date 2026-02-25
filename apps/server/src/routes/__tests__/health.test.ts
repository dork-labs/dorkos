import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies that createApp imports
vi.mock('../../services/session/transcript-reader.js', () => ({
  transcriptReader: {
    listSessions: vi.fn(),
    getSession: vi.fn(),
    readTranscript: vi.fn(),
    listTranscripts: vi.fn(),
  },
}));

vi.mock('../../services/core/agent-manager.js', () => ({
  agentManager: {
    ensureSession: vi.fn(),
    sendMessage: vi.fn(),
    approveTool: vi.fn(),
    hasSession: vi.fn(),
    checkSessionHealth: vi.fn(),
    getSdkSessionId: vi.fn(),
  },
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

import request from 'supertest';
import { createApp } from '../../app.js';
import { tunnelManager } from '../../services/core/tunnel-manager.js';

const app = createApp();

describe('Health Route', () => {
  beforeEach(() => {
    // Reset to disabled state
    (tunnelManager as unknown as Record<string, unknown>).status = {
      enabled: false,
      connected: false,
      url: null,
      port: null,
      startedAt: null,
    };
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
      enabled: true,
      connected: true,
      url: 'https://test.ngrok.io',
      port: 4242,
      startedAt: '2025-01-01T00:00:00.000Z',
    };

    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.tunnel).toEqual({
      connected: true,
      url: 'https://test.ngrok.io',
      port: 4242,
      startedAt: '2025-01-01T00:00:00.000Z',
    });
  });

  it('GET /api/health shows disconnected tunnel after stop', async () => {
    (tunnelManager as unknown as Record<string, unknown>).status = {
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
