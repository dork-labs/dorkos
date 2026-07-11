import { describe, it, expect } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { buildAuthRateLimiter } from '../auth-rate-limit.js';

/**
 * The limiter is configured with `max: 10` per window. Kept in sync with the
 * source constant so the tests document the shipped budget.
 */
const MAX_ATTEMPTS = 10;

/**
 * Build a throwaway app that mounts a FRESH limiter (its own in-memory store, so
 * tests never bleed budget into one another) ahead of stand-in auth and non-auth
 * routes, mirroring the real `app.ts` wiring: app-wide limiter, then handlers.
 *
 * @param maxAttempts - Optional override for the per-window budget (defaults to
 *   the limiter's own default of 10), used to exercise the env-override path.
 */
function makeApp(maxAttempts?: number): Express {
  const app = express();
  // Match production: read the client IP from the first proxy hop.
  app.set('trust proxy', 1);
  app.use(buildAuthRateLimiter({ maxAttempts }));
  // Stand-ins for the Better Auth handler and a normal API route.
  app.post('/api/auth/sign-in/email', (_req, res) => res.status(200).json({ ok: true }));
  app.post('/api/auth/sign-up/email', (_req, res) => res.status(200).json({ ok: true }));
  app.get('/api/auth/get-session', (_req, res) => res.status(200).json({ session: null }));
  // A future OAuth-initiation endpoint (invites/OAuth spec) — a redirect
  // handshake, not a password guess. Must never be throttled.
  app.post('/api/auth/sign-in/social', (_req, res) => res.status(200).json({ url: 'https://x' }));
  app.post('/api/sessions', (_req, res) => res.status(200).json({ ok: true }));
  return app;
}

describe('buildAuthRateLimiter', () => {
  it('allows sign-in attempts up to the limit, then returns a clean 429', async () => {
    const app = makeApp();

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const res = await request(app).post('/api/auth/sign-in/email').send({ email: 'a@b.c' });
      expect(res.status).toBe(200);
    }

    const blocked = await request(app).post('/api/auth/sign-in/email').send({ email: 'a@b.c' });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('lets a legitimate user retry a fat-fingered password well under the limit', async () => {
    const app = makeApp();

    // A handful of failed attempts (what a real mistyped-password retry looks
    // like) must all pass through — the limiter never locks out normal use.
    for (let i = 0; i < 4; i++) {
      const res = await request(app).post('/api/auth/sign-in/email').send({ email: 'a@b.c' });
      expect(res.status).toBe(200);
    }
  });

  it('also throttles sign-up POSTs (credential probing)', async () => {
    const app = makeApp();

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await request(app).post('/api/auth/sign-up/email').send({ email: 'a@b.c' });
    }
    const blocked = await request(app).post('/api/auth/sign-up/email').send({ email: 'a@b.c' });
    expect(blocked.status).toBe(429);
  });

  it('never throttles benign session-check GETs', async () => {
    const app = makeApp();

    // Far more than the limit: GETs are skipped, so none consume the budget.
    for (let i = 0; i < MAX_ATTEMPTS * 3; i++) {
      const res = await request(app).get('/api/auth/get-session');
      expect(res.status).toBe(200);
    }
  });

  it('does not throttle non-password auth POSTs like sign-in/social (OAuth initiation)', async () => {
    const app = makeApp();

    // Only /sign-in/email and /sign-up/email are password endpoints; a future
    // OAuth handshake at /sign-in/social must keep its full budget.
    for (let i = 0; i < MAX_ATTEMPTS * 3; i++) {
      const res = await request(app).post('/api/auth/sign-in/social').send({ provider: 'github' });
      expect(res.status).toBe(200);
    }
  });

  it('does not cover non-auth routes', async () => {
    const app = makeApp();

    for (let i = 0; i < MAX_ATTEMPTS * 3; i++) {
      const res = await request(app).post('/api/sessions').send({});
      expect(res.status).toBe(200);
    }
  });

  it('respects a maxAttempts override (the DORKOS_AUTH_SIGNIN_RATE_LIMIT knob)', async () => {
    // A locked-out owner (or dev/QA loop) can relax or tighten the budget via
    // env without a restart. Here a tighter cap of 2 blocks on the 3rd attempt.
    const app = makeApp(2);

    for (let i = 0; i < 2; i++) {
      const res = await request(app).post('/api/auth/sign-in/email').send({ email: 'a@b.c' });
      expect(res.status).toBe(200);
    }
    const blocked = await request(app).post('/api/auth/sign-in/email').send({ email: 'a@b.c' });
    expect(blocked.status).toBe(429);
  });

  it('keys the budget on the client IP so distinct clients get separate buckets', async () => {
    const app = makeApp();

    // Exhaust the budget for one forwarded client IP.
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await request(app)
        .post('/api/auth/sign-in/email')
        .set('X-Forwarded-For', '203.0.113.1')
        .send({ email: 'a@b.c' });
    }
    const blocked = await request(app)
      .post('/api/auth/sign-in/email')
      .set('X-Forwarded-For', '203.0.113.1')
      .send({ email: 'a@b.c' });
    expect(blocked.status).toBe(429);

    // A different client IP still has its full budget.
    const other = await request(app)
      .post('/api/auth/sign-in/email')
      .set('X-Forwarded-For', '203.0.113.2')
      .send({ email: 'a@b.c' });
    expect(other.status).toBe(200);
  });
});
