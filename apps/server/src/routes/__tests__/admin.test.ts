import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mutable env stand-in — DORKOS_MANAGED_BY is read per request, so each test
// sets it without re-importing the module.
const mockEnv = vi.hoisted(() => ({
  NODE_ENV: 'test',
  DORKOS_MANAGED_BY: undefined as 'desktop' | undefined,
}));
vi.mock('../../env.js', () => ({ env: mockEnv }));

// Mock fs/promises
vi.mock('fs/promises', () => ({
  default: { rm: vi.fn().mockResolvedValue(undefined) },
}));

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

import { createAdminRouter, MANAGED_BY_DESKTOP_CODE } from '../admin.js';
import { spawn } from 'child_process';
import fs from 'fs/promises';

/** The data directory the refusal copy has to name so "delete it" is actionable. */
const DORK_HOME = '/tmp/test-dork-home';

// Mock process.exit to prevent test runner from exiting
const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

describe('Admin routes', () => {
  let app: express.Express;
  let mockShutdownServices: ReturnType<typeof vi.fn>;
  let mockCloseDb: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.DORKOS_MANAGED_BY = undefined;
    mockShutdownServices = vi.fn().mockResolvedValue(undefined);
    mockCloseDb = vi.fn();
    app = express();
    app.use(express.json());
    app.use(
      '/api/admin',
      createAdminRouter({
        dorkHome: DORK_HOME,
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

  describe('when the desktop app manages the server (DORKOS_MANAGED_BY=desktop)', () => {
    beforeEach(() => {
      mockEnv.DORKOS_MANAGED_BY = 'desktop';
    });

    it('refuses a restart with 409 and never exits the process', async () => {
      const res = await request(app).post('/api/admin/restart');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe(MANAGED_BY_DESKTOP_CODE);
      expect(res.body.error).toContain('Quit DorkOS and open it again');
      expect(mockShutdownServices).not.toHaveBeenCalled();
      expect(mockExit).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    });

    it('refuses a reset with 409 and never deletes the data directory', async () => {
      const res = await request(app).post('/api/admin/reset').send({ confirm: 'reset' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe(MANAGED_BY_DESKTOP_CODE);
      expect(mockCloseDb).not.toHaveBeenCalled();
      expect(mockShutdownServices).not.toHaveBeenCalled();
      expect(mockExit).not.toHaveBeenCalled();
    });

    // Quitting and reopening IS a restart, so that advice completes the user's
    // intent. It deletes nothing, so giving it for a reset would send someone
    // away believing their data was wiped when it is all still there.
    it('does not tell a reset caller that reopening the app resets anything', async () => {
      const res = await request(app).post('/api/admin/reset').send({ confirm: 'reset' });

      expect(res.body.error).toContain('Nothing has been deleted');
      expect(res.body.error).toContain(DORK_HOME);
      expect(res.body.error).not.toMatch(/open it again instead/);
    });

    // Express 5 routes non-strictly and case-insensitively, so every spelling
    // below reaches the same handler while `req.path` differs. A path-keyed
    // refusal missed the trailing-slash forms, and `POST /api/admin/reset/`
    // ran `fs.rm(dorkHome, { recursive: true })` and exited — in the one mode
    // whose whole purpose is to prevent that, past a message promising
    // "Nothing has been deleted."
    it.each([
      '/api/admin/reset',
      '/api/admin/reset/',
      '/api/admin/RESET',
      '/api/admin/RESET/',
      '/api/admin/restart',
      '/api/admin/restart/',
      '/api/admin/RESTART/',
    ])('refuses %s without touching the data directory', async (path) => {
      const res = await request(app).post(path).send({ confirm: 'reset' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe(MANAGED_BY_DESKTOP_CODE);
      expect(mockShutdownServices).not.toHaveBeenCalled();
      expect(mockCloseDb).not.toHaveBeenCalled();
      expect(mockExit).not.toHaveBeenCalled();
      expect(fs.rm).not.toHaveBeenCalled();
    });

    // The 409 is a fixed fact about this deployment, not load to shed. Behind
    // the limiter, a fourth tap on Restart replaced the explanation with "Too
    // many admin requests" for five minutes.
    it('keeps explaining itself past the rate limit', async () => {
      for (let i = 0; i < 4; i++) {
        await request(app).post('/api/admin/restart');
      }
      const res = await request(app).post('/api/admin/restart');

      expect(res.status).toBe(409);
      expect(res.body.code).toBe(MANAGED_BY_DESKTOP_CODE);
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
