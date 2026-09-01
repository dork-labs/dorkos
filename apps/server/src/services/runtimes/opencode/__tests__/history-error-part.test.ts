import { describe, it, expect } from 'vitest';
import { mapMessageError } from '../history-error-part.js';

/**
 * Verbatim `error.data.message` strings from this machine's OpenCode store
 * (`~/.local/share/opencode/opencode.db`, read 2026-09-01). Copied exactly,
 * links and quoting included, so the fixtures cannot drift into a tidier
 * failure than the ones that actually happen.
 */
const MEASURED = {
  /** 3 of the 6 measured `APIError` rows — the modal real failure. */
  noEndpoints:
    'No endpoints found that support tool use. Try disabling "bash". To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection',
  outOfCredits:
    'This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 2809. To increase, visit https://openrouter.ai/settings/credits and upgrade to a paid account',
} as const;

describe('mapMessageError', () => {
  it('returns null when the message carried no error', () => {
    expect(mapMessageError(undefined)).toBeNull();
  });

  it('suppresses a user interrupt — an abort is not a failure', () => {
    // Measured: all 6 `MessageAbortedError` rows carry exactly this payload.
    expect(
      mapMessageError({ name: 'MessageAbortedError', data: { message: 'Aborted' } })
    ).toBeNull();
  });

  it('keeps a measured provider failure verbatim, links and all', () => {
    expect(
      mapMessageError({
        name: 'APIError',
        data: {
          message: MEASURED.outOfCredits,
          statusCode: 402,
          isRetryable: false,
          metadata: { url: 'https://openrouter.ai/api/v1/chat/completions' },
        },
      })
    ).toEqual({
      type: 'error',
      message: MEASURED.outOfCredits,
      category: 'execution_error',
      details: '[APIError]',
    });
  });

  it('keeps the modal measured failure verbatim', () => {
    // The one place the two surfaces disagree: live rewrites this to friendly
    // model-menu copy, history shows the provider's own words. Recorded in the
    // module doc; unifying it is a follow-up on the live regex.
    expect(mapMessageError({ name: 'APIError', data: { message: MEASURED.noEndpoints } })).toEqual({
      type: 'error',
      message: MEASURED.noEndpoints,
      category: 'execution_error',
      details: '[APIError]',
    });
  });

  // CONSTRUCTED, not measured: this store holds zero `ProviderAuthError` rows,
  // so the auth shape below is built from the SDK's declared type rather than
  // observed on disk. It is the case the whole ticket is about, so it is
  // covered — labelled honestly rather than dressed up as evidence.
  it('maps a provider credential failure to an auth_error part (constructed shape)', () => {
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

  it('classifies an auth failure that arrives under a generic error name', () => {
    const part = mapMessageError({
      name: 'APIError',
      data: { message: '401 Unauthorized', isRetryable: false },
    });
    expect(part?.category).toBe('auth_error');
  });

  it('falls back to the error name when the payload carries no message', () => {
    // Measured shape class: `MessageOutputLengthError.data` genuinely has none.
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

  // The sidecar is an unpinned external binary and its generated types have
  // been wrong before (DOR-1147). None of these may throw: this runs inside
  // `getMessageHistory`, whose throw the facade turns into the log-backed
  // fallback — empty for a TUI-adopted session — so one off-type row would
  // cost the whole conversation instead of one error part.
  describe('off-type payloads cost one part, never a throw', () => {
    it.each([
      ['null', null],
      ['a bare string', 'ProviderAuthError'],
      ['a number', 42],
      ['an array', ['ProviderAuthError']],
      ['no name', { data: { message: 'orphaned' } }],
      ['an empty name', { name: '', data: { message: 'nameless' } }],
      ['a non-string name', { name: 404, data: { message: 'numeric' } }],
    ])('drops the part for %s', (_label, error) => {
      expect(() => mapMessageError(error)).not.toThrow();
      expect(mapMessageError(error)).toBeNull();
    });

    it.each([
      ['a missing data field', { name: 'APIError' }],
      ['a null data field', { name: 'APIError', data: null }],
      ['a non-object data field', { name: 'APIError', data: 'boom' }],
      ['a non-string message', { name: 'APIError', data: { message: 500 } }],
    ])('still names the failure for %s', (_label, error) => {
      expect(() => mapMessageError(error)).not.toThrow();
      // The name is all this row can honestly say, so it says that — dropping
      // the failure entirely would be a worse answer than a vaguer one.
      expect(mapMessageError(error)).toEqual({
        type: 'error',
        message: 'APIError',
        category: 'execution_error',
      });
    });
  });
});
