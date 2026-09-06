import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import express, { type RequestHandler } from 'express';
import { createServer } from 'node:http';
import { once } from 'node:events';
import request from '@dorkos/test-utils/supertest';
import { buildAuthRateLimiter } from '../auth-rate-limit.js';
import { env } from '../../env.js';

/**
 * The limiter is configured with `max: 10` per window. Kept in sync with the
 * source constant so the tests document the shipped budget.
 */
const MAX_ATTEMPTS = 10;

/**
 * The limiter the single app delegates to, swapped per test by {@link makeApp}.
 * Each test still gets a FRESH limiter (its own in-memory store, so budgets
 * never bleed between tests) without a new listener.
 */
let currentLimiter: RequestHandler = (_req, _res, next) => next();

/**
 * ONE listener for the whole file — zero port churn (DOR-465).
 *
 * Two things had to go, and the second is why one-listener-per-test was not
 * enough. Supertest handed a non-listening app opens a fresh ephemeral listener
 * per REQUEST (`if (!addr) this._server = app.listen(0)`) and closes it in the
 * response callback; this file makes ~130 requests. But Node 24's
 * `http.globalAgent` sets `keepAlive: true`, so superagent pools sockets keyed
 * by `host:port` — and an ephemeral port freed by a closing listener is
 * immediately reclaimable by the next `listen(0)`. A pooled socket for
 * `127.0.0.1:P` then gets handed to a request meant for the NEW server on P.
 * That surfaces two ways: `Error: Parse Error: Expected HTTP/, RTSP/ or ICE/`
 * when the peer is gone, and — worse because it is silent — a request routed to
 * a PREVIOUS test's server and its limiter, scoring a 200 where a 429 was due.
 * `closeAllConnections()` narrows that window but cannot close it; the agent can
 * hand out the entry before the RST lands.
 *
 * Binding once and never rebinding removes the mechanism instead of narrowing
 * it: no port is ever freed mid-file, so no pooled socket can be misrouted.
 */
const app = express();
// Match production: read the client IP from the first proxy hop.
app.set('trust proxy', 1);
app.use((req, res, next) => currentLimiter(req, res, next));
// Stand-ins for the Better Auth handler and a normal API route.
app.post('/api/auth/sign-in/email', (_req, res) => res.status(200).json({ ok: true }));
app.post('/api/auth/sign-up/email', (_req, res) => res.status(200).json({ ok: true }));
app.get('/api/auth/get-session', (_req, res) => res.status(200).json({ session: null }));
// A future OAuth-initiation endpoint (invites/OAuth spec) — a redirect
// handshake, not a password guess. Must never be throttled.
app.post('/api/auth/sign-in/social', (_req, res) => res.status(200).json({ url: 'https://x' }));
app.post('/api/sessions', (_req, res) => res.status(200).json({ ok: true }));

const server = createServer(app);

beforeAll(async () => {
  server.listen(0);
  await once(server, 'listening');
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * Install a FRESH limiter for the current test and return the shared server.
 * Mirrors the real `app.ts` wiring: app-wide limiter, then handlers.
 *
 * @param maxAttempts - Optional override for the per-window budget (defaults to
 *   the limiter's own default of 10), used to exercise the env-override path.
 */
function makeApp(maxAttempts?: number): typeof server {
  currentLimiter = buildAuthRateLimiter({ maxAttempts });
  return server;
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

    // Assert every request in the loop, not just the one after it: an unchecked
    // 429 mid-loop (or a request that reached a DIFFERENT test's limiter) would
    // otherwise be invisible and leave the final assertion passing by luck.
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const res = await request(app).post('/api/auth/sign-up/email').send({ email: 'a@b.c' });
      expect(res.status, `sign-up attempt ${i + 1} of ${MAX_ATTEMPTS} must be within budget`).toBe(
        200
      );
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

  /**
   * The bug this limiter existed to have, and did not survive (DOR-1711).
   *
   * These tests used to assert the opposite of the first case below: that
   * rotating `X-Forwarded-For` put a caller in a different bucket. It did — the
   * limiter inherited `req.ip`, `app.ts` sets `trust proxy, 1`, and on a direct
   * connection the "first proxy" is the caller. Read as a security property that
   * is "a password guesser gets a fresh budget for every value it invents",
   * which is no brake at all on the one surface where a brake is the whole
   * point. What looked like a passing test for per-client buckets was a passing
   * test for the bypass.
   *
   * `trust proxy, 1` is still set on the app above, deliberately, so these prove
   * the limiter no longer inherits it rather than proving the app was
   * reconfigured around it.
   */
  describe('bucket keys (DOR-1711)', () => {
    const mutableEnv = env as { DORKOS_TRUST_PROXY: boolean };

    afterEach(() => {
      mutableEnv.DORKOS_TRUST_PROXY = false;
    });

    it('does NOT hand a rotating X-Forwarded-For a fresh budget', async () => {
      const app = makeApp();

      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        const res = await request(app)
          .post('/api/auth/sign-in/email')
          .set('X-Forwarded-For', `203.0.113.${i + 1}`)
          .send({ email: 'a@b.c' });
        expect(res.status, `attempt ${i + 1} of ${MAX_ATTEMPTS} must be within budget`).toBe(200);
      }

      // A brand-new spoofed value, and the budget is still spent: every one of
      // these requests came from the same socket, which is the key.
      const blocked = await request(app)
        .post('/api/auth/sign-in/email')
        .set('X-Forwarded-For', '198.51.100.77')
        .send({ email: 'a@b.c' });
      expect(blocked.status).toBe(429);
    });

    it('keys on the forwarded client IP when DORKOS_TRUST_PROXY says a proxy is in front', async () => {
      mutableEnv.DORKOS_TRUST_PROXY = true;
      const app = makeApp();

      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        const res = await request(app)
          .post('/api/auth/sign-in/email')
          .set('X-Forwarded-For', '203.0.113.1')
          .send({ email: 'a@b.c' });
        expect(res.status, `attempt ${i + 1} of ${MAX_ATTEMPTS} must be within budget`).toBe(200);
      }
      const blocked = await request(app)
        .post('/api/auth/sign-in/email')
        .set('X-Forwarded-For', '203.0.113.1')
        .send({ email: 'a@b.c' });
      expect(blocked.status).toBe(429);

      // A different client behind that proxy still has its full budget — which
      // is the whole point of turning the flag on, and the whole risk of it.
      const other = await request(app)
        .post('/api/auth/sign-in/email')
        .set('X-Forwarded-For', '203.0.113.2')
        .send({ email: 'a@b.c' });
      expect(other.status).toBe(200);
    });

    it('reads the flag per request, so it cannot be captured at mount time', async () => {
      // The limiter is built once at boot in `app.ts`. A posture resolved there
      // would be the posture forever, which is how a flag ends up meaning
      // nothing after the first restart of a long-lived process.
      const app = makeApp();

      const direct = await request(app)
        .post('/api/auth/sign-in/email')
        .set('X-Forwarded-For', '203.0.113.9')
        .send({ email: 'a@b.c' });
      expect(direct.status).toBe(200);

      mutableEnv.DORKOS_TRUST_PROXY = true;
      // Same limiter, same store: the socket bucket has one attempt in it and
      // `203.0.113.9` has none, so this must be a fresh budget.
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        const res = await request(app)
          .post('/api/auth/sign-in/email')
          .set('X-Forwarded-For', '203.0.113.9')
          .send({ email: 'a@b.c' });
        expect(res.status, `attempt ${i + 1} of ${MAX_ATTEMPTS} must be within budget`).toBe(200);
      }
    });
  });
});
