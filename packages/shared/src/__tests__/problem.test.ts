import { describe, expect, it } from 'vitest';
import { ProblemCodeSchema as CloudProblemCodeSchema } from '@dork-labs/cloud-api';
import {
  PROBLEM_CODE_LIST,
  PROBLEM_CODES,
  ProblemCodeSchema,
  ProblemSchema,
  isProblem,
  problemType,
} from '../problem.js';

describe('PROBLEM_CODE_LIST', () => {
  it('names each code once', () => {
    const codes = PROBLEM_CODE_LIST.map((entry) => entry.code);
    const repeated = codes.filter((code, index) => codes.indexOf(code) !== index);
    expect(repeated).toEqual([]);
  });

  it('spells every code lower_snake, as the Cloud contract does', () => {
    for (const { code } of PROBLEM_CODE_LIST) expect(code).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
  });

  it('gives every code an error status and a title', () => {
    for (const { status, title } of PROBLEM_CODE_LIST) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThanOrEqual(599);
      expect(title.trim()).not.toBe('');
    }
  });

  it('indexes every code, and the schema accepts exactly the list', () => {
    expect(Object.keys(PROBLEM_CODES).sort()).toEqual(
      PROBLEM_CODE_LIST.map((entry) => entry.code).sort()
    );
    expect(ProblemCodeSchema.options.length).toBe(PROBLEM_CODE_LIST.length);
    expect(ProblemCodeSchema.safeParse('NOT_FOUND').success).toBe(false);
  });
});

describe('agreement with the DorkOS Cloud contract', () => {
  it('spells every code both lists hold the same way', () => {
    const cloud = new Set<string>(CloudProblemCodeSchema.options);
    const ours = PROBLEM_CODE_LIST.map((entry) => entry.code);
    const shared = ours.filter((code) => cloud.has(code));
    // A code that differs only in case or separators is a misspelling of a shared one.
    const fold = (code: string) => code.toLowerCase().replace(/[^a-z]/g, '');
    const cloudFolded = new Map([...cloud].map((code) => [fold(code), code]));
    const misspelled = ours.filter((code) => !cloud.has(code) && cloudFolded.has(fold(code)));
    expect(misspelled).toEqual([]);
    expect(shared).toEqual(
      expect.arrayContaining(['unauthenticated', 'forbidden', 'malformed_request', 'not_found'])
    );
  });

  it('reads a Cloud-shaped problem, which has no type', () => {
    expect(
      isProblem({
        code: 'rate_limited',
        status: 429,
        title: 'Slow down.',
        retryAfterMs: 1000,
        requiredPlanDisplayName: 'Any plan',
      })
    ).toBe(true);
  });
});

describe('ProblemSchema', () => {
  const minimal = {
    type: problemType('not_found'),
    title: 'Not found.',
    status: 404,
    code: 'not_found',
  };

  it('accepts a minimal problem and a full one', () => {
    expect(isProblem(minimal)).toBe(true);
    expect(
      isProblem({
        ...minimal,
        code: 'malformed_request',
        status: 400,
        detail: 'The name is missing.',
        instance: 'req_1',
        retryAfterMs: 0,
        issues: { formErrors: [], fieldErrors: { name: ['Required'] } },
      })
    ).toBe(true);
  });

  it('refuses a body in the old `{ error, code }` shape', () => {
    expect(isProblem({ error: 'Not found', code: 'NOT_FOUND' })).toBe(false);
  });

  it('refuses a success status', () => {
    expect(ProblemSchema.safeParse({ ...minimal, status: 200 }).success).toBe(false);
  });
});
