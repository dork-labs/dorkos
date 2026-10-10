/**
 * `censusProblems` is the judge the census test relies on, so it is tested on
 * its own: each way a census can drift must produce a line, and an exact match
 * none. A deliberately removed route is the first case.
 */
import { describe, expect, it } from 'vitest';
import { censusProblems } from '../route-census/census.js';

const baseline = { hono: ['GET /api/health'], express: ['GET /api/models', 'POST /api/models'] };

describe('censusProblems', () => {
  it('finds nothing when the census matches', () => {
    expect(censusProblems(baseline, baseline)).toEqual([]);
  });

  it('names a route that disappeared', () => {
    const actual = { hono: ['GET /api/health'], express: ['GET /api/models'] };
    expect(censusProblems(actual, baseline)).toEqual(['express no longer serves POST /api/models']);
  });

  it('names a route the baseline does not know', () => {
    const actual = { ...baseline, express: [...baseline.express, 'GET /api/new'] };
    expect(censusProblems(actual, baseline)).toEqual([
      'express now serves GET /api/new, not in the baseline',
    ]);
  });

  it('names a route both frameworks serve', () => {
    const actual = { hono: ['GET /api/health'], express: [...baseline.express, 'GET /api/health'] };
    expect(censusProblems(actual, baseline)).toContain('both frameworks serve GET /api/health');
  });

  it('names a move the baseline does not record', () => {
    const actual = { hono: ['GET /api/health', 'GET /api/models'], express: ['POST /api/models'] };
    expect(censusProblems(actual, baseline)).toEqual([
      'hono now serves GET /api/models, not in the baseline',
      'express no longer serves GET /api/models',
    ]);
  });
});
