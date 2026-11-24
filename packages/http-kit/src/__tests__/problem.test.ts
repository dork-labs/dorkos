import { Hono } from 'hono';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { PROBLEM_CONTENT_TYPE, isProblem } from '@dorkos/shared/problem';
import {
  problem,
  problemBody,
  sendProblem,
  validationDetail,
  validationProblem,
} from '../problem.js';

describe('problemBody', () => {
  it('takes the status and title from the code list', () => {
    expect(problemBody('session_locked')).toEqual({
      type: 'urn:dorkos:problem:session_locked',
      title: 'This chat is busy with another reply.',
      status: 409,
      code: 'session_locked',
    });
  });

  it('lets one occurrence override the status and add its detail', () => {
    const body = problemBody('not_found', { status: 410, detail: 'Gone for good.' });
    expect(body).toMatchObject({ status: 410, detail: 'Gone for good.' });
    expect(isProblem(body)).toBe(true);
  });
});

describe('problemBody options', () => {
  it('accepts only error statuses', () => {
    // @ts-expect-error a problem never carries a success status
    expect(() => problemBody('not_found', { status: 200 })).not.toThrow();
    expect(problemBody('not_found', { status: 410 }).status).toBe(410);
  });

  it('rounds retryAfterMs up to a whole, non-negative number', () => {
    expect(problemBody('rate_limited', { retryAfterMs: 1500.2 }).retryAfterMs).toBe(1501);
    expect(problemBody('rate_limited', { retryAfterMs: -5 }).retryAfterMs).toBe(0);
    expect(isProblem(problemBody('rate_limited', { retryAfterMs: 0.4 }))).toBe(true);
  });
});

describe('problem', () => {
  it('answers with the problem media type, the status and a Retry-After', async () => {
    const app = new Hono();
    app.get('/', (c) => problem(c, 'rate_limited', { retryAfterMs: 1500 }));
    const res = await app.request('/');
    expect(res.status).toBe(429);
    expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE);
    expect(res.headers.get('retry-after')).toBe('2');
    const body: unknown = await res.json();
    expect(isProblem(body)).toBe(true);
    expect(body).toMatchObject({ code: 'rate_limited', retryAfterMs: 1500 });
  });
});

describe('sendProblem', () => {
  it('answers a built document with its own status and the problem media type', async () => {
    const app = new Hono();
    const body = problemBody('request_too_large', { detail: 'Too big.' });
    app.get('/', (c) => sendProblem(c, body));
    const res = await app.request('/');
    expect(res.status).toBe(413);
    expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE);
    expect(res.headers.get('retry-after')).toBeNull();
    expect(await res.json()).toEqual(body);
  });
});

describe('validationProblem', () => {
  it('answers invalid_request with the flattened issues and a detail naming the first field', async () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const app = new Hono();
    app.post('/', (c) => {
      const parsed = schema.safeParse({ age: 'old' });
      return parsed.success ? c.text('ok') : validationProblem(c, parsed.error);
    });
    const res = await app.request('/', { method: 'POST' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      code: string;
      detail: string;
      issues: { fieldErrors: object };
    };
    expect(isProblem(body)).toBe(true);
    expect(body.code).toBe('invalid_request');
    expect(body.detail).toMatch(/^`name`: .+ \(and 1 more\)\.$/);
    expect(Object.keys(body.issues.fieldErrors).sort()).toEqual(['age', 'name']);
  });
});

describe('validationDetail', () => {
  it('names the first field, ending in one full stop', () => {
    expect(validationDetail({ formErrors: [], fieldErrors: { name: ['Required'] } })).toBe(
      '`name`: Required.'
    );
  });

  it('counts the rest, and reads a whole-value message', () => {
    expect(
      validationDetail({ formErrors: ['Too short.'], fieldErrors: { a: ['Bad'], b: ['Worse'] } })
    ).toBe('`a`: Bad (and 2 more).');
    expect(validationDetail({ formErrors: ['Expected object'], fieldErrors: {} })).toBe(
      'Expected object.'
    );
  });

  it('keeps to fifteen words, and says nothing when nothing failed', () => {
    const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ');
    const detail = validationDetail({ formErrors: [long], fieldErrors: {} })!;
    expect(detail.split(/\s+/).length).toBeLessThanOrEqual(15);
    expect(validationDetail({ formErrors: [], fieldErrors: {} })).toBeUndefined();
  });
});
