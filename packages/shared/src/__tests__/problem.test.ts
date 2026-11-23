import { describe, expect, it } from 'vitest';
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
