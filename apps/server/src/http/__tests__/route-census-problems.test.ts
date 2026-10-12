/**
 * `censusProblems` is the judge the census test relies on, so it is tested on
 * its own: each way a census can drift must produce a line, and an exact match
 * none. A deliberately removed route is the first case.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { censusProblems, routeCensus, serveRouteCensus } from '../route-census/census.js';

const baseline = { routes: ['GET /api/health', 'GET /api/models', 'POST /api/models'] };

describe('censusProblems', () => {
  it('finds nothing when the census matches', () => {
    expect(censusProblems(baseline, baseline)).toEqual([]);
  });

  it('names a route that disappeared', () => {
    const actual = { routes: ['GET /api/health', 'GET /api/models'] };
    expect(censusProblems(actual, baseline)).toEqual(['no longer serves POST /api/models']);
  });

  it('names a route the baseline does not know', () => {
    const actual = { routes: [...baseline.routes, 'GET /api/new'] };
    expect(censusProblems(actual, baseline)).toEqual([
      'now serves GET /api/new, not in the baseline',
    ]);
  });
});

describe('routeCensus', () => {
  it('lists routes and path middleware, but not the chain or the census itself', () => {
    const app = new Hono();
    app.use(async (_c, next) => next());
    app.use('/api/gated/*', async (_c, next) => next());
    app.get('/api/health', (c) => c.text('ok'));
    app.post('/api/models', (c) => c.text('ok'));
    serveRouteCensus(app);
    expect(routeCensus(app).routes).toEqual([
      'ALL /api/gated/*',
      'GET /api/health',
      'POST /api/models',
    ]);
  });
});
