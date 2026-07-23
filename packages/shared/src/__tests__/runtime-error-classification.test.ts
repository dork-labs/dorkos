import { describe, expect, it } from 'vitest';
import { AUTH_ERROR_SUBTYPES, detectAuthError } from '../runtime-error-classification.js';

describe('detectAuthError', () => {
  it('matches the exact Claude Code 401 example', () => {
    expect(
      detectAuthError({
        message:
          'Claude Code returned an error result: Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
        code: 'error_during_execution',
      })
    ).toBe(true);
  });

  describe('positive message patterns', () => {
    const positives: Array<[string, string]> = [
      ['oauth', 'OAuth token problem'],
      ['unauthorized', 'Request was unauthorized'],
      ['unauthorised', 'Request was unauthorised'],
      ['401 Unauthorized', '401 Unauthorized'],
      ['revoked', 'The access token has been revoked'],
      ['failed to authenticate', 'Failed to authenticate with the provider'],
      ['authentication', 'authentication error occurred'],
      ['access token', 'access token missing or malformed'],
      ['invalid api key', 'Invalid API key provided'],
      ['invalid_api_key', 'invalid_api_key'],
      ['auth token expired', 'Your auth token has expired, please sign in'],
      ['api key expired', 'API key has expired'],
      ['credential expired', 'The credential is expired'],
      ['canonical 401 example', 'API Error: 401 OAuth access token has been revoked.'],
    ];

    it.each(positives)('matches %s', (_label, message) => {
      expect(detectAuthError({ message })).toBe(true);
    });
  });

  describe('subtype codes', () => {
    it.each([...AUTH_ERROR_SUBTYPES])('matches the %s code', (code) => {
      expect(detectAuthError({ message: 'opaque runtime failure', code })).toBe(true);
    });

    it('matches ProviderAuthError by name even when the message has no keyword', () => {
      // OpenCode's real provider-auth error name; its data.message can be generic.
      expect(
        detectAuthError({ message: 'the provider ended the session', code: 'ProviderAuthError' })
      ).toBe(true);
    });

    it('matches a subtype code even with an empty message', () => {
      expect(detectAuthError({ message: '', code: 'authentication_failed' })).toBe(true);
    });
  });

  describe('negatives that must NOT match', () => {
    const negatives: Array<[string, string]> = [
      ['generic execution', 'execution failed'],
      ['rate limit', 'rate limit exceeded, try again later'],
      ['network timeout', 'network timeout after 30s'],
      ['overloaded', 'The model is overloaded'],
      ['generic stack trace', 'TypeError: cannot read property foo of undefined\n  at bar.ts:12'],
      ['plain expired (no credential noun)', 'This session has expired'],
      ['tool error', 'Tool run_command exited with code 1'],
      ['file not found', 'ENOENT: no such file or directory'],
      // Over-broad-regex regression guards (code review):
      ['line-number 401', 'Parse failure at handler.ts:401:12'],
      ['budget 401 amount', 'Budget of $401.00 exceeded'],
      ['context token budget expired', 'Context window token budget expired for this run'],
      ['cache entry expired key', 'Cache entry expired; object key foo missing'],
      ['free trial expired key', 'free trial expired. Press any key to continue.'],
    ];

    it.each(negatives)('does not match %s', (_label, message) => {
      expect(detectAuthError({ message })).toBe(false);
    });

    it('does not match empty input', () => {
      expect(detectAuthError({})).toBe(false);
      expect(detectAuthError({ message: null, code: null })).toBe(false);
      expect(detectAuthError({ message: '   ' })).toBe(false);
    });

    it('does not match an unrelated code', () => {
      expect(detectAuthError({ message: 'boom', code: 'turn_failed' })).toBe(false);
    });
  });
});
