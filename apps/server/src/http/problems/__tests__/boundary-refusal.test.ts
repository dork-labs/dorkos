import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { BoundaryError } from '../../../lib/boundary.js';
import { boundaryProblem, pathRefusalProblem } from '../boundary-refusal.js';

/** Answer one request with the path refusal for `err`, and read what went out. */
async function answer(err: unknown) {
  const app = new Hono();
  app.get('/', (c) => pathRefusalProblem(c, err) ?? c.text('unhandled', 500));
  const res = await app.request('/');
  const type = res.headers.get('content-type');
  return { status: res.status, type, body: type?.includes('json') ? await res.json() : null };
}

describe('boundaryProblem', () => {
  it('answers a path outside the boundary 403 outside_boundary, naming no path', async () => {
    const app = new Hono();
    app.get('/', (c) =>
      boundaryProblem(c, new BoundaryError('Access denied: /etc is outside', 'OUTSIDE_BOUNDARY'))
    );
    const res = await app.request('/');
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = await res.json();
    expect(body.code).toBe('outside_boundary');
    expect(JSON.stringify(body)).not.toContain('/etc');
  });
});

describe('pathRefusalProblem', () => {
  it('answers a NUL byte 400 invalid_request', async () => {
    const res = await answer(new BoundaryError('Invalid path: null bytes', 'NULL_BYTE'));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
  });

  it('answers a folder the system would not open 403 forbidden', async () => {
    const res = await answer(new BoundaryError('Permission denied', 'PERMISSION_DENIED'));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
  });

  it('answers a path the system could not follow 400 invalid_request', async () => {
    const res = await answer(Object.assign(new Error('loop'), { code: 'ELOOP' }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
  });

  it('leaves anything else to the caller', async () => {
    const res = await answer(new Error('disk on fire'));
    expect(res.status).toBe(500);
    expect(res.body).toBeNull();
  });
});
