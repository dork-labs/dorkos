/**
 * `GET /api/config` reports the SCHEMA's defaults for a section it cannot read,
 * not a copy of them typed into the route (DOR-1432 stage-2 review, nit 4).
 *
 * ## The failure this guards
 *
 * The route is a hand-curated DTO, and several sections are written
 * `configManager.get(x) ?? { …literal… }`. That literal is a second declaration
 * of a default, sitting outside the guard in
 * `packages/shared/src/__tests__/config-schema.test.ts` that keeps the per-field
 * and section-literal declarations in step. Raising
 * `scheduler.maxConcurrentRuns` from 1 to 4 moved two of those declarations and
 * would have left this one answering `1` — the cockpit showing a number no
 * install has.
 *
 * `scheduler` now reads `USER_CONFIG_DEFAULTS.scheduler`, so its case here is
 * close to tautological and is kept as the regression that says "do not type it
 * out again". **`logging` is the live one**: it is still a hand-written literal,
 * and this is the only thing standing between it and the same drift. If a third
 * section grows a literal, add it here.
 *
 * The fallback branch is reachable in production — `configManager.get` answers
 * `undefined` for a section absent from a config written by an older build — so
 * this is behaviour, not a source-text assertion.
 *
 * @module routes/__tests__/config-dto-fallbacks
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: { status: { enabled: false, connected: false, url: null } },
}));

vi.mock('../../lib/boundary.js', () => ({
  getBoundary: () => '/Users/test-user',
  expandTilde: (p: string) => p,
}));

/**
 * A config manager that can read NOTHING — every section absent, which is what
 * drives the route down each `??` branch at once.
 */
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: () => undefined, getDot: () => undefined },
}));

describe('GET /api/config falls back to the schema, not to a retyped literal', () => {
  let app: express.Application;

  beforeEach(async () => {
    vi.resetModules();
    const { default: configRouter } = await import('../config.js');
    app = express();
    app.use(express.json());
    app.use('/api/config', configRouter);
  });

  it('reports the schema scheduler defaults, including the raised concurrency', () => {
    // Pinned as a VALUE as well as an equality, because the equality alone would
    // stay green if both sides were wrong together.
    expect(USER_CONFIG_DEFAULTS.scheduler.maxConcurrentRuns).toBe(4);
  });

  it('answers with the schema scheduler block when the section cannot be read', async () => {
    const res = await request(app).get('/api/config').expect(200);

    expect(res.body.scheduler).toMatchObject({
      maxConcurrentRuns: USER_CONFIG_DEFAULTS.scheduler.maxConcurrentRuns,
      timezone: USER_CONFIG_DEFAULTS.scheduler.timezone,
      retentionCount: USER_CONFIG_DEFAULTS.scheduler.retentionCount,
    });
  });

  it('answers with the schema logging block when the section cannot be read', async () => {
    // The one still written out by hand in the route. If this goes red, the
    // literal there has drifted from the schema — fix the route, not this test.
    const res = await request(app).get('/api/config').expect(200);

    expect(res.body.logging).toEqual({
      level: USER_CONFIG_DEFAULTS.logging.level,
      maxLogSizeKb: USER_CONFIG_DEFAULTS.logging.maxLogSizeKb,
      maxLogFiles: USER_CONFIG_DEFAULTS.logging.maxLogFiles,
    });
  });
});
