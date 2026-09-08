import { describe, expect, it } from 'vitest';
import {
  AUTH_ERROR_SUBTYPES,
  describeCodexDiagnostic,
  describeKnownModelError,
  describeAuthError,
  describeRuntimeError,
  detectAuthError,
} from '../runtime-error-classification.js';

const CODEX_UPDATE_ERROR =
  '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6-astra\' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}}';
const CHATGPT_MODEL_ERROR =
  '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.4\' model is not supported when using Codex with a ChatGPT account."}}';

describe('describeCodexDiagnostic', () => {
  it.each([
    [
      'Model metadata for `gpt-6-astra` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.',
      'Using fallback settings for gpt-6-astra.',
    ],
    [
      'This session was recorded with model `gpt-6-astra` but is resuming with `gpt-5.4`. Consider switching back to `gpt-6-astra` as it may affect Codex performance.',
      'Resumed with gpt-5.4 instead of gpt-6-astra.',
    ],
    [
      'Falling back from WebSockets to HTTPS. stream disconnected before completion',
      'Codex switched to a standard connection.',
    ],
  ])('turns a known nonfatal diagnostic into calm status copy', (message, expected) => {
    expect(describeCodexDiagnostic(message)).toBe(expected);
  });

  it('does not suppress an unknown item error', () => {
    expect(describeCodexDiagnostic('Tool failed with exit code 1')).toBeNull();
  });
});

describe('describeKnownModelError', () => {
  it('extracts an update-required model error from nested JSON and keeps the raw payload', () => {
    expect(describeKnownModelError(CODEX_UPDATE_ERROR)).toEqual({
      message:
        'The Codex version DorkOS is using is too old for gpt-6-astra. Update DorkOS (or your custom Codex installation), then try again. You can also choose another model.',
      category: 'runtime_update_required',
      details: CODEX_UPDATE_ERROR,
    });
  });

  it('explains that a model is unavailable with a ChatGPT account', () => {
    expect(describeKnownModelError(CHATGPT_MODEL_ERROR)).toEqual({
      message:
        'gpt-5.4 isn\u2019t available with a ChatGPT account. Choose another model from the model menu.',
      category: 'model_unavailable',
      details: CHATGPT_MODEL_ERROR,
    });
  });

  it('leaves unknown JSON and unrelated failures alone', () => {
    expect(describeKnownModelError('{"error":{"message":"Unknown model error"}}')).toBeNull();
    expect(describeKnownModelError('Tool run_command exited with code 1')).toBeNull();
  });
});

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

  describe('unambiguousOnly', () => {
    // The channel this exists for is codex's error ITEM, which carries per-tool
    // diagnostics on turns that go on to succeed. Sign-in advice stamped over a
    // live turn's real error is worse than saying nothing.
    const vagueButAuthFlavoured: Array<[string, string]> = [
      ['an MCP server naming its own auth', 'MCP error: Failed to authenticate with server github'],
      ['a tool discussing an oauth flow', 'The github tool needs an OAuth app configured'],
      ['a tool naming an access token', 'Set GH_TOKEN: no access token found for this repo'],
      ['a third-party key', 'weather-api returned: invalid api key'],
    ];

    it.each(vagueButAuthFlavoured)('ignores %s', (_label, message) => {
      expect(detectAuthError({ message })).toBe(true);
      expect(detectAuthError({ message, unambiguousOnly: true })).toBe(false);
    });

    const stillMatched: Array<[string, string]> = [
      ['401 Unauthorized', 'stream error: unexpected status 401 Unauthorized'],
      ['a revoked credential', 'OAuth access token has been revoked'],
    ];

    it.each(stillMatched)('still matches %s', (_label, message) => {
      expect(detectAuthError({ message, unambiguousOnly: true })).toBe(true);
    });

    it('still trusts an exact code, which needs no corroboration from the text', () => {
      expect(
        detectAuthError({
          message: 'the provider ended the session',
          code: 'ProviderAuthError',
          unambiguousOnly: true,
        })
      ).toBe(true);
    });
  });
});

describe('describeAuthError', () => {
  it('names the runtime that failed, never a hardcoded one', () => {
    // The defect this pins: an OpenCode credential failure telling somebody to
    // re-authenticate Claude.
    expect(describeAuthError('claude-code')).toContain('Claude');
    expect(describeAuthError('codex')).toContain('Codex');
    expect(describeAuthError('opencode')).toContain('OpenCode');
    expect(describeAuthError('opencode')).not.toContain('Claude');
  });

  it('tells a login runtime to sign in again', () => {
    expect(describeAuthError('claude-code')).toBe(
      'Your Claude sign-in stopped working. Sign in again to keep going.'
    );
    expect(describeAuthError('codex')).toBe(
      'Your Codex sign-in stopped working. Sign in again to keep going.'
    );
  });

  it('tells a provider-picker runtime about its PROVIDER, not a sign-in it does not have', () => {
    // OpenCode has no login of its own: it borrows a model provider's
    // credential, which is why reconnecting it opens the provider picker rather
    // than a sign-in screen (runtimeAuthConnectKind). Telling somebody to "sign
    // in to OpenCode again" would send them looking for a button that is not
    // there. The closing instruction matches the one they will actually see.
    expect(describeAuthError('opencode')).toBe(
      "OpenCode's model provider stopped accepting its sign-in. Choose a model provider to keep going."
    );
  });

  it('falls back to the raw type for a runtime nobody has named yet', () => {
    // Honest but plain, matching runtimeDisplayName — never a blank space where
    // a name should be.
    expect(describeAuthError('some-future-runtime')).toContain('some-future-runtime');
  });
});

describe('describeRuntimeError', () => {
  it('translates a credential failure and keeps the backend words in details', () => {
    expect(
      describeRuntimeError({
        runtimeType: 'opencode',
        message: 'AuthenticationError: 401 invalid x-api-key',
        code: 'ProviderAuthError',
      })
    ).toEqual({
      message:
        "OpenCode's model provider stopped accepting its sign-in. Choose a model provider to keep going.",
      category: 'auth_error',
      details: 'AuthenticationError: 401 invalid x-api-key',
    });
  });

  it('classifies on the CODE alone when the backend text says nothing useful', () => {
    // A provider can end a session with generic words; the error NAME is then
    // the only signal, and missing it costs the person their way back in.
    const copy = describeRuntimeError({
      runtimeType: 'opencode',
      message: 'the provider ended the session',
      code: 'ProviderAuthError',
    });
    expect(copy.category).toBe('auth_error');
    expect(copy.details).toBe('the provider ended the session');
  });

  it('passes an ordinary failure through verbatim, with no details to duplicate it', () => {
    expect(
      describeRuntimeError({
        runtimeType: 'codex',
        message: 'Tool run_command exited with code 1',
        code: 'turn_failed',
      })
    ).toEqual({ message: 'Tool run_command exited with code 1', category: 'execution_error' });
  });
});
