import { describe, expect, it } from 'vitest';
import { getErrorCode } from '../crud-errors';

const coded = (code: string) => Object.assign(new Error('refused'), { code, status: 403 });

describe('getErrorCode', () => {
  it('reads a file route’s boundary refusal', () => {
    expect(getErrorCode(coded('outside_boundary'))).toBe('outside_boundary');
  });

  it('no longer reads the retired SCREAMING spellings', () => {
    expect(getErrorCode(coded('OUTSIDE_BOUNDARY'))).toBeUndefined();
    expect(getErrorCode(coded('DIR_NOT_EMPTY'))).toBeUndefined();
  });

  it('ignores a code it has no sentence for', () => {
    expect(getErrorCode(coded('internal_error'))).toBeUndefined();
  });
});
