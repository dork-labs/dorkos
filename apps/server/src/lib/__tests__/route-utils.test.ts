import { describe, it, expect } from 'vitest';
import { errorBody, parseSessionId } from '../route-utils.js';

describe('parseSessionId', () => {
  it('accepts and returns a valid UUID', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(parseSessionId(uuid)).toBe(uuid);
  });

  it('returns null for path traversal strings', () => {
    expect(parseSessionId('../../../etc/passwd')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseSessionId('')).toBeNull();
  });

  it('returns null for a numeric string', () => {
    expect(parseSessionId('12345')).toBeNull();
  });

  it('returns null for a random non-UUID string', () => {
    expect(parseSessionId('not-a-valid-uuid-at-all')).toBeNull();
  });
});

describe('errorBody', () => {
  it('is the repo error shape', () => {
    expect(errorBody('Not found', 'NOT_FOUND')).toEqual({ error: 'Not found', code: 'NOT_FOUND' });
  });
});
