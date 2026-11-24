import { describe, expect, it } from 'vitest';
import { getErrorCode } from '../crud-errors';

const coded = (code: string) => Object.assign(new Error('refused'), { code, status: 403 });

describe('getErrorCode', () => {
  it('reads a file route’s own boundary refusal', () => {
    expect(getErrorCode(coded('OUTSIDE_BOUNDARY'))).toBe('OUTSIDE_BOUNDARY');
  });

  it('reads the error handler’s outside_boundary problem as the same refusal', () => {
    expect(getErrorCode(coded('outside_boundary'))).toBe('OUTSIDE_BOUNDARY');
  });

  it('ignores a code it has no sentence for', () => {
    expect(getErrorCode(coded('internal_error'))).toBeUndefined();
  });
});
