import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAdminRouter } from '../admin.js';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  default: { rm: vi.fn().mockResolvedValue(undefined) },
}));

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

// Mock process.exit to prevent test runner from exiting
const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

describe('Admin routes', () => {
  let app: express.Express;
  let mockShutdownServices: ReturnType<typeof vi.fn>;
  let mockCloseDb: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockShutdownServices = vi.fn().mockResolvedValue(undefined);
    mockCloseDb = vi.fn();
    app = express();
    app.use(express.json());
    app.use(
      '/api/admin',
      createAdminRouter({
        dorkHome: '/tmp/test-dork-home',
        shutdownServices: mockShutdownServices,
        closeDb: mockCloseDb,
      })
    );
  });

  afterEach(() => {
    mockExit.mockClear();
  });

  describe('POST /api/admin/reset', () => {
    it('returns 400 without confirm field', async () => {
      const res = await request(app).post('/api/admin/reset').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('confirm');
    });

    it('returns 400 with wrong confirm value', async () => {
      const res = await request(app).post('/api/admin/reset').send({ confirm: 'delete' });
      expect(res.status).toBe(400);
    });

    it('returns 200 with correct confirm value', async () => {
      const res = await request(app).post('/api/admin/reset').send({ confirm: 'reset' });
      expect(res.status).toBe(200);
      expect(res.body.message).toContain('Reset initiated');
    });
  });

  describe('POST /api/admin/restart', () => {
    it('returns 200', async () => {
      const res = await request(app).post('/api/admin/restart');
      expect(res.status).toBe(200);
      expect(res.body.message).toContain('Restart initiated');
    });
  });

  describe('rate limiting', () => {
    it('returns 429 after 3 requests within 5 minutes', async () => {
      await request(app).post('/api/admin/restart');
      await request(app).post('/api/admin/restart');
      await request(app).post('/api/admin/restart');
      const res = await request(app).post('/api/admin/restart');
      expect(res.status).toBe(429);
    });
  });
});
