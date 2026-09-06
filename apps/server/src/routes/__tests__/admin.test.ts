import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';

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

import { createAdminRouter, MANAGED_BY_DESKTOP_CODE, RESET_TOKEN_REQUIRED_CODE } from '../admin.js';
import { RESET_TOKEN_TTL_MS } from '../../services/core/auth/reset-token.js';
import { spawn } from 'child_process';
import fs from 'fs/promises';

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

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

    fixtureTarget.mount(app);
  });

  afterEach(() => {
    mockExit.mockClear();
  });

  /** Let anything the route queued with `setImmediate` actually run. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  /** Arm a reset the way the app does, and return the one-time token it was handed. */
  async function armReset(): Promise<string> {
    const res = await request(fixtureServer).post('/api/admin/reset/prepare');
    expect(res.status).toBe(200);
    return res.body.token;
  }

  describe('POST /api/admin/reset', () => {
    it('returns 400 without confirm field', async () => {
      const res = await request(fixtureServer).post('/api/admin/reset').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('confirm');
    });

    it('returns 400 with wrong confirm value', async () => {
      const res = await request(fixtureServer).post('/api/admin/reset').send({ confirm: 'delete' });
      expect(res.status).toBe(400);
    });

    it('resets on a freshly minted token', async () => {
      const res = await request(fixtureServer)
        .post('/api/admin/reset')
        .send({ confirm: 'reset', token: await armReset() });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('Reset initiated');
      await settle();
      expect(mockShutdownServices).toHaveBeenCalled();
      expect(mockCloseDb).toHaveBeenCalled();
      expect(fs.rm).toHaveBeenCalledWith(DORK_HOME, { recursive: true, force: true });
    });
  });

  // The filed attack (DOR-1707): with local login off, nothing in front of this
  // route asked the caller for anything, so one POST carrying a string copied
  // out of the client's source deleted the whole data directory. Every case
  // below is that same POST, and every one of them has to leave `fs.rm` unrun.
  describe('a reset without a live one-time token', () => {
    /** Post a reset with whatever token (or none) and assert nothing was deleted. */
    async function expectRefused(body: Record<string, unknown>) {
      const res = await request(fixtureServer)
        .post('/api/admin/reset')
        .send({ confirm: 'reset', ...body });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(RESET_TOKEN_REQUIRED_CODE);
      expect(res.body.error).toContain('Nothing has been deleted');
      await settle();
      expect(fs.rm).not.toHaveBeenCalled();
      expect(mockShutdownServices).not.toHaveBeenCalled();
      expect(mockCloseDb).not.toHaveBeenCalled();
      expect(mockExit).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    }

    it('refuses the one blind POST that used to wipe the data directory', async () => {
      await expectRefused({});
    });

    it('refuses a guessed token', async () => {
      await armReset();
      await expectRefused({ token: 'not-the-token' });
    });

    it('refuses a token of the wrong type', async () => {
      await armReset();
      await expectRefused({ token: 42 });
    });

    it('refuses a token minted for an earlier attempt', async () => {
      const stale = await armReset();
      await armReset(); // arming again replaces it
      await expectRefused({ token: stale });
    });

    it('refuses a token that has expired', async () => {
      const token = await armReset();
      const realNow = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(realNow + RESET_TOKEN_TTL_MS + 1);
      try {
        await expectRefused({ token });
      } finally {
        clock.mockRestore();
      }
    });

    it('refuses a token that already reset the machine', async () => {
      const token = await armReset();
      const first = await request(fixtureServer)
        .post('/api/admin/reset')
        .send({ confirm: 'reset', token });
      expect(first.status).toBe(200);
      await settle();
      vi.clearAllMocks();

      const replay = await request(fixtureServer)
        .post('/api/admin/reset')
        .send({ confirm: 'reset', token });

      expect(replay.status).toBe(403);
      expect(replay.body.code).toBe(RESET_TOKEN_REQUIRED_CODE);
      await settle();
      expect(fs.rm).not.toHaveBeenCalled();
    });

    // A wrong guess must not disarm the operator's real token: anything able to
    // POST could then keep a person from ever finishing a reset.
    it('leaves the armed token usable after a wrong guess', async () => {
      const token = await armReset();
      await expectRefused({ token: 'not-the-token' });

      const res = await request(fixtureServer)
        .post('/api/admin/reset')
        .send({ confirm: 'reset', token });

      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/admin/restart', () => {
    it('returns 200', async () => {
      const res = await request(fixtureServer).post('/api/admin/restart');
      expect(res.status).toBe(200);
      expect(res.body.message).toContain('Restart initiated');
    });
  });

  describe('when the desktop app manages the server (DORKOS_MANAGED_BY=desktop)', () => {
    beforeEach(() => {
      mockEnv.DORKOS_MANAGED_BY = 'desktop';
    });

    it('refuses a restart with 409 and never exits the process', async () => {
      const res = await request(fixtureServer).post('/api/admin/restart');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe(MANAGED_BY_DESKTOP_CODE);
      expect(res.body.error).toContain('Quit DorkOS and open it again');
      expect(mockShutdownServices).not.toHaveBeenCalled();
      expect(mockExit).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    });

    it('refuses a reset with 409 and never deletes the data directory', async () => {
      const res = await request(fixtureServer).post('/api/admin/reset').send({ confirm: 'reset' });
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
      const res = await request(fixtureServer).post('/api/admin/reset').send({ confirm: 'reset' });

      expect(res.body.error).toContain('Nothing has been deleted');
      expect(res.body.error).toContain(DORK_HOME);
      expect(res.body.error).not.toMatch(/open it again instead/);
    });

    // Arming a reset is refused for the same reason as finishing one, so it says
    // the same thing rather than the generic "not available here".
    it('gives the first step of a reset the same instructions as the second', async () => {
      const res = await request(fixtureServer).post('/api/admin/reset/prepare');

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('Nothing has been deleted');
      expect(res.body.error).toContain(DORK_HOME);
      expect(res.body.token).toBeUndefined();
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
      '/api/admin/reset/prepare',
      '/api/admin/reset/prepare/',
      '/api/admin/restart',
      '/api/admin/restart/',
      '/api/admin/RESTART/',
    ])('refuses %s without touching the data directory', async (path) => {
      const res = await request(fixtureServer).post(path).send({ confirm: 'reset' });

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
        await request(fixtureServer).post('/api/admin/restart');
      }
      const res = await request(fixtureServer).post('/api/admin/restart');

      expect(res.status).toBe(409);
      expect(res.body.code).toBe(MANAGED_BY_DESKTOP_CODE);
    });
  });

  describe('rate limiting', () => {
    it('returns 429 after 3 requests within 5 minutes', async () => {
      await request(fixtureServer).post('/api/admin/restart');
      await request(fixtureServer).post('/api/admin/restart');
      await request(fixtureServer).post('/api/admin/restart');
      const res = await request(fixtureServer).post('/api/admin/restart');
      expect(res.status).toBe(429);
    });

    // Reset and restart still share one three-in-five-minutes budget, and arming
    // a reset is not part of it. On a single shared limiter, opening the reset
    // dialog three times would have spent the whole budget and answered the
    // reset itself with "Too many admin requests".
    it('does not spend the acting budget on arming a reset', async () => {
      await armReset();
      await armReset();
      const token = await armReset();

      const res = await request(fixtureServer)
        .post('/api/admin/reset')
        .send({ confirm: 'reset', token });

      expect(res.status).toBe(200);
    });

    // A refused reset is an attack that failed. Counted against the budget, three
    // of them would take Restart away from the operator for five minutes — the
    // denial of service the attacker could not get any other way.
    it('does not spend the acting budget on a reset it refused', async () => {
      for (let i = 0; i < 3; i++) {
        const refused = await request(fixtureServer)
          .post('/api/admin/reset')
          .send({ confirm: 'reset' });
        expect(refused.status).toBe(403);
      }

      const token = await armReset();
      const reset = await request(fixtureServer)
        .post('/api/admin/reset')
        .send({ confirm: 'reset', token });
      const restart = await request(fixtureServer).post('/api/admin/restart');

      expect(reset.status).toBe(200);
      expect(restart.status).toBe(200);
    });

    // …and the budget is still a budget: what actually ends this process counts.
    it('still stops a fourth acting request', async () => {
      await request(fixtureServer).post('/api/admin/restart');
      await request(fixtureServer).post('/api/admin/restart');
      const token = await armReset();
      const reset = await request(fixtureServer)
        .post('/api/admin/reset')
        .send({ confirm: 'reset', token });
      const fourth = await request(fixtureServer).post('/api/admin/restart');

      expect(reset.status).toBe(200);
      expect(fourth.status).toBe(429);
    });
  });
});
