/**
 * The one limiter (DOR-2796): its counting, and its answer through each chain.
 *
 * The counting is tested with a clock passed in, because a sliding window is
 * about time. The answers are tested through real servers, once per adapter,
 * against one table: the two chains must refuse alike, with the same headers
 * and body, or a moved route would change what a client sees.
 */
import { describe, expect, it } from 'vitest';
import express, { type RequestHandler } from 'express';
import { Hono } from 'hono';
import request from '@dorkos/test-utils/supertest';
import { honoListener, swappableServer } from '@dorkos/test-utils/listening-server';
import {
  createRateLimiter,
  expressRateLimit,
  honoRateLimit,
  rateLimitHeaders,
  type HonoRateLimitOptions,
  type RateLimitHeaders,
} from '../rate-limiter.js';
import type { RequestFactsEnv } from '../request-facts.js';

describe('createRateLimiter', () => {
  const policy = { windowMs: 60_000, limit: 3 };

  it('allows the limit, then refuses', () => {
    const limiter = createRateLimiter(policy);
    const answers = [0, 1, 2, 3].map((t) => limiter.hit('a', t));
    expect(answers.map((d) => d.allowed)).toEqual([true, true, true, false]);
    expect(answers.map((d) => d.remaining)).toEqual([2, 1, 0, 0]);
  });

  it('frees one slot when the oldest request leaves the window, not the whole budget', () => {
    const limiter = createRateLimiter(policy);
    limiter.hit('a', 0);
    limiter.hit('a', 30_000);
    limiter.hit('a', 30_001);
    expect(limiter.hit('a', 59_999).allowed).toBe(false);
    // The request at 0 has left; the two at 30s have not.
    expect(limiter.hit('a', 60_000)).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.hit('a', 60_001).allowed).toBe(false);
  });

  it('never admits more than the limit in any stretch of one window', () => {
    // The fixed-window flaw this replaces: a full budget at the end of one
    // window and another at the start of the next.
    const limiter = createRateLimiter(policy);
    for (const t of [59_000, 59_001, 59_002]) expect(limiter.hit('a', t).allowed).toBe(true);
    for (const t of [60_500, 61_000, 61_500]) expect(limiter.hit('a', t).allowed).toBe(false);
  });

  it('does not record a refusal, so a caller that keeps knocking waits one window', () => {
    const limiter = createRateLimiter(policy);
    for (const t of [0, 1, 2]) limiter.hit('a', t);
    for (let t = 3; t < 60_000; t += 1_000) limiter.hit('a', t);
    expect(limiter.hit('a', 60_003).allowed).toBe(true);
  });

  it('says when the oldest request leaves', () => {
    const limiter = createRateLimiter(policy);
    limiter.hit('a', 1_000);
    expect(limiter.hit('a', 5_000).resetAt).toBe(61_000);
  });

  it('keeps one bucket per key', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, limit: 1 });
    expect(limiter.hit('a', 0).allowed).toBe(true);
    expect(limiter.hit('b', 0).allowed).toBe(true);
    expect(limiter.hit('a', 1).allowed).toBe(false);
  });

  it('gives a refunded count back, once', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, limit: 1 });
    const first = limiter.hit('a', 0);
    first.refund();
    first.refund();
    expect(limiter.hit('a', 1).allowed).toBe(true);
    expect(limiter.hit('a', 2).allowed).toBe(false);
  });

  it('refuses a newcomer when every bucket is live, rather than drop one', () => {
    // Dropping a live bucket would give its owner a fresh budget: a guesser
    // rotating through more keys than the table holds would never be limited.
    const limiter = createRateLimiter({ windowMs: 60_000, limit: 1, maxKeys: 2 });
    expect(limiter.hit('a', 0).allowed).toBe(true);
    expect(limiter.hit('b', 1).allowed).toBe(true);
    expect(limiter.hit('c', 2).allowed).toBe(false);
    expect(limiter.hit('a', 3).allowed).toBe(false); // `a` kept its spent budget
  });

  it('makes room for a newcomer once a bucket has expired', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, limit: 1, maxKeys: 2 });
    limiter.hit('a', 0);
    limiter.hit('b', 30_000);
    expect(limiter.hit('c', 60_001).allowed).toBe(true); // `a` expired and went
    expect(limiter.hit('b', 60_002).allowed).toBe(false); // `b` is still live
  });

  it('drops a bucket a refund empties', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, limit: 1, maxKeys: 1 });
    limiter.hit('a', 0).refund();
    expect(limiter.hit('b', 1).allowed).toBe(true);
  });
});

describe('rateLimitHeaders', () => {
  const policy = { windowMs: 60_000, limit: 2 };

  it('writes the draft-6 headers express-rate-limit wrote', () => {
    const decision = createRateLimiter(policy).hit('a', 0);
    expect(rateLimitHeaders(decision, policy, 'standard', 0)).toEqual({
      'RateLimit-Policy': '2;w=60',
      'RateLimit-Limit': '2',
      'RateLimit-Remaining': '1',
      'RateLimit-Reset': '60',
    });
  });

  it('writes the legacy headers, with the reset as a time', () => {
    const decision = createRateLimiter(policy).hit('a', 0);
    expect(rateLimitHeaders(decision, policy, 'legacy', 0)).toEqual({
      'X-RateLimit-Limit': '2',
      'X-RateLimit-Remaining': '1',
      Date: new Date(0).toUTCString(),
      'X-RateLimit-Reset': '60',
    });
  });

  it('adds Retry-After to a refusal', () => {
    const limiter = createRateLimiter(policy);
    limiter.hit('a', 0);
    limiter.hit('a', 0);
    const refused = limiter.hit('a', 15_500);
    expect(rateLimitHeaders(refused, policy, 'standard', 15_500)['Retry-After']).toBe('45');
  });
});

/** One app per chain, its only route behind a limiter with these options. */
type Build = (options: {
  limit: number;
  headers: RateLimitHeaders;
  skipPath?: string;
  refundStatus?: number;
}) => Parameters<ReturnType<typeof swappableServer>['mount']>[0];

const MESSAGE = { error: 'Too many requests here.', code: 'LIMITED' };

const buildExpress: Build = ({ limit, headers, skipPath, refundStatus }) => {
  const app = express();
  const limiter: RequestHandler = expressRateLimit({
    windowMs: 60_000,
    limit,
    headers,
    message: MESSAGE,
    ...(skipPath ? { skip: (req) => req.path === skipPath } : {}),
    ...(refundStatus ? { countsWhen: (_req, res) => res.statusCode !== refundStatus } : {}),
  });
  app.use(limiter);
  app.get('/ok', (_req, res) => res.send('ok'));
  app.get('/free', (_req, res) => res.send('free'));
  app.get('/refused', (_req, res) => res.status(refundStatus ?? 403).send('no'));
  app.get('/raw', (_req, res) => res.send('raw'));
  return app;
};

const buildHono: Build = ({ limit, headers, skipPath, refundStatus }) => {
  const app = new Hono<RequestFactsEnv>();
  const options: HonoRateLimitOptions = {
    windowMs: 60_000,
    limit,
    headers,
    message: MESSAGE,
    ...(skipPath ? { skip: (c) => c.req.path === skipPath } : {}),
    ...(refundStatus ? { countsWhen: (c) => c.res.status !== refundStatus } : {}),
  };
  app.use(honoRateLimit(options));
  app.get('/ok', (c) => c.text('ok'));
  app.get('/free', (c) => c.text('free'));
  app.get('/refused', (c) => c.text('no', (refundStatus ?? 403) as 403));
  // A handler that answers with its own Response, as a proxied fetch does.
  app.get('/raw', () => new Response('raw'));
  return honoListener(app);
};

const target = swappableServer();

describe.each([
  ['express', buildExpress],
  ['hono', buildHono],
] as const)('through the %s adapter', (_name, build) => {
  it('answers with the standard headers until the limit, then a 429 with Retry-After', async () => {
    const server = target.mount(build({ limit: 2, headers: 'standard' }));
    const first = await request(server).get('/ok');
    expect(first.status).toBe(200);
    expect(first.headers['ratelimit-policy']).toBe('2;w=60');
    expect(first.headers['ratelimit-limit']).toBe('2');
    expect(first.headers['ratelimit-remaining']).toBe('1');
    expect(first.headers['ratelimit-reset']).toBe('60');
    expect(first.headers['x-ratelimit-limit']).toBeUndefined();
    expect(first.headers['retry-after']).toBeUndefined();

    await request(server).get('/ok');
    const refused = await request(server).get('/ok');
    expect(refused.status).toBe(429);
    expect(refused.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(refused.body).toEqual(MESSAGE);
    expect(refused.headers['ratelimit-remaining']).toBe('0');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('answers with the legacy headers when asked', async () => {
    const server = target.mount(build({ limit: 1, headers: 'legacy' }));
    const first = await request(server).get('/ok');
    expect(first.headers['x-ratelimit-limit']).toBe('1');
    expect(first.headers['x-ratelimit-remaining']).toBe('0');
    expect(Number(first.headers['x-ratelimit-reset'])).toBeGreaterThan(Date.now() / 1000);
    expect(first.headers['ratelimit-limit']).toBeUndefined();
    const refused = await request(server).get('/ok');
    expect(refused.status).toBe(429);
    expect(refused.headers['retry-after']).toBeDefined();
  });

  it('keeps its headers on an answer the handler built itself', async () => {
    const server = target.mount(build({ limit: 2, headers: 'standard' }));
    const res = await request(server).get('/raw');
    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-limit']).toBe('2');
    expect(res.headers['ratelimit-remaining']).toBe('1');
  });

  it('counts nothing for a skipped request', async () => {
    const server = target.mount(build({ limit: 1, headers: 'standard', skipPath: '/free' }));
    for (let i = 0; i < 3; i++) expect((await request(server).get('/free')).status).toBe(200);
    expect((await request(server).get('/ok')).status).toBe(200);
  });

  it('gives back the count of an answer that does not count', async () => {
    const server = target.mount(build({ limit: 1, headers: 'standard', refundStatus: 403 }));
    for (let i = 0; i < 3; i++) expect((await request(server).get('/refused')).status).toBe(403);
    expect((await request(server).get('/ok')).status).toBe(200);
    expect((await request(server).get('/ok')).status).toBe(429);
  });
});
