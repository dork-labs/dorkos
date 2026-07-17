import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock the cloud-link manager accessor — the route is thin over it, so the
// route test only proves wiring + response shapes, not the flow (covered by
// cloud-link.test.ts). vi.hoisted() ensures mockManager is initialized before
// vi.mock's factory runs (vi.mock is hoisted above all imports).
const mockManager = vi.hoisted(() => ({
  startLink: vi.fn(),
  getStatus: vi.fn(),
  unlink: vi.fn(),
  getSummary: vi.fn(),
}));
vi.mock('../../services/core/auth/cloud-link.js', () => ({
  getCloudLinkManager: () => mockManager,
}));

import cloudRouter from '../cloud.js';

const manager = mockManager;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/cloud', cloudRouter);
  return app;
}

describe('cloud routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/cloud/link/start', () => {
    it('returns the device codes from the manager', async () => {
      manager.startLink.mockResolvedValue({
        userCode: 'ABCD1234',
        verificationUri: 'https://dorkos.ai/activate',
        expiresAt: '2026-07-03T00:30:00Z',
      });
      const res = await request(buildApp()).post('/api/cloud/link/start').expect(200);
      expect(res.body).toEqual({
        userCode: 'ABCD1234',
        verificationUri: 'https://dorkos.ai/activate',
        expiresAt: '2026-07-03T00:30:00Z',
      });
      expect(manager.startLink).toHaveBeenCalledOnce();
    });

    it('returns 502 when the cloud is unreachable', async () => {
      manager.startLink.mockRejectedValue(new Error('fetch failed'));
      const res = await request(buildApp()).post('/api/cloud/link/start').expect(502);
      expect(res.body.error).toMatch(/cloud/i);
    });
  });

  describe('GET /api/cloud/link/status', () => {
    it('returns the link-flow state machine', async () => {
      manager.getStatus.mockReturnValue({
        state: 'pending',
        lastHeartbeatAt: undefined,
      });
      const res = await request(buildApp()).get('/api/cloud/link/status').expect(200);
      expect(res.body.state).toBe('pending');
    });

    it('surfaces the unlinked state', async () => {
      manager.getStatus.mockReturnValue({ state: 'unlinked' });
      const res = await request(buildApp()).get('/api/cloud/link/status').expect(200);
      expect(res.body).toEqual({ state: 'unlinked' });
    });
  });

  describe('POST /api/cloud/unlink', () => {
    it('unlinks and returns ok', async () => {
      manager.unlink.mockResolvedValue(undefined);
      const res = await request(buildApp()).post('/api/cloud/unlink').expect(200);
      expect(res.body).toEqual({ ok: true });
      expect(manager.unlink).toHaveBeenCalledOnce();
    });

    it('returns 500 when unlink throws', async () => {
      manager.unlink.mockRejectedValue(new Error('boom'));
      await request(buildApp()).post('/api/cloud/unlink').expect(500);
    });
  });

  describe('GET /api/cloud/status', () => {
    it('returns the settled linked summary', async () => {
      manager.getSummary.mockReturnValue({
        linked: true,
        accountLabel: 'Kai',
        lastHeartbeatAt: '2026-07-03T00:00:00Z',
      });
      const res = await request(buildApp()).get('/api/cloud/status').expect(200);
      expect(res.body).toEqual({
        linked: true,
        accountLabel: 'Kai',
        lastHeartbeatAt: '2026-07-03T00:00:00Z',
      });
    });

    it('reports not-linked', async () => {
      manager.getSummary.mockReturnValue({
        linked: false,
        accountLabel: null,
        lastHeartbeatAt: null,
      });
      const res = await request(buildApp()).get('/api/cloud/status').expect(200);
      expect(res.body.linked).toBe(false);
    });
  });
});
