import { describe, expect, it } from 'vitest';

import { authErrorMessage, RATE_LIMIT_MESSAGE } from '../auth-errors';

describe('authErrorMessage', () => {
  it('returns null when there is no error', () => {
    expect(authErrorMessage(null)).toBeNull();
    expect(authErrorMessage(undefined)).toBeNull();
  });

  it('maps a 429 to clear retry-after copy regardless of the raw message', () => {
    expect(authErrorMessage({ status: 429 })).toBe(RATE_LIMIT_MESSAGE);
    expect(authErrorMessage({ status: 429, message: 'rate limited' })).toBe(RATE_LIMIT_MESSAGE);
  });

  it('passes through the server message for other statuses', () => {
    expect(authErrorMessage({ status: 401, message: 'Invalid email or password' })).toBe(
      'Invalid email or password'
    );
  });

  it('falls back to a generic message when none is provided', () => {
    expect(authErrorMessage({ status: 500 })).toBe('Something went wrong. Please try again.');
  });
});
