import { describe, it, expect } from 'vitest';
import { mapMessageError } from '../history-error-part.js';

describe('mapMessageError', () => {
  it('returns null when the message carried no error', () => {
    expect(mapMessageError(undefined)).toBeNull();
  });

  it('suppresses a user interrupt — an abort is not a failure', () => {
    expect(
      mapMessageError({ name: 'MessageAbortedError', data: { message: 'Aborted' } })
    ).toBeNull();
  });

  it('maps a provider credential failure to an auth_error part', () => {
    expect(
      mapMessageError({
        name: 'ProviderAuthError',
        data: { providerID: 'anthropic', message: 'OAuth token revoked' },
      })
    ).toEqual({
      type: 'error',
      message: 'OAuth token revoked',
      category: 'auth_error',
      details: '[ProviderAuthError]',
    });
  });

  it('maps an ordinary provider failure to an execution_error part, keeping its text', () => {
    // Measured shape: a real APIError from this machine's OpenCode store.
    expect(
      mapMessageError({
        name: 'APIError',
        data: {
          message:
            'This request requires more credits, or fewer max_tokens. Visit https://openrouter.ai/settings/credits',
          isRetryable: false,
        },
      })
    ).toEqual({
      type: 'error',
      message:
        'This request requires more credits, or fewer max_tokens. Visit https://openrouter.ai/settings/credits',
      category: 'execution_error',
      details: '[APIError]',
    });
  });

  it('classifies an auth failure that arrives under a generic error name', () => {
    const part = mapMessageError({
      name: 'APIError',
      data: { message: '401 Unauthorized', isRetryable: false },
    });
    expect(part?.category).toBe('auth_error');
  });

  it('falls back to the error name when the payload carries no message', () => {
    expect(mapMessageError({ name: 'MessageOutputLengthError', data: {} })).toEqual({
      type: 'error',
      message: 'MessageOutputLengthError',
      category: 'execution_error',
    });
  });

  it('falls back to the error name when the payload message is empty', () => {
    expect(mapMessageError({ name: 'UnknownError', data: { message: '' } })).toEqual({
      type: 'error',
      message: 'UnknownError',
      category: 'execution_error',
    });
  });
});
