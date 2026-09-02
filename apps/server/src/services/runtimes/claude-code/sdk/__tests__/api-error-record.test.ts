import { describe, it, expect } from 'vitest';
import { apiErrorCode, buildApiErrorPart, isApiErrorRecord } from '../api-error-record.js';

describe('isApiErrorRecord', () => {
  // The exact shape the CLI wrote for the reported failure (transcript
  // 70fd483b…, 2026-09-01): both markers on an `assistant` record.
  it('recognises a synthetic auth-failure record', () => {
    expect(
      isApiErrorRecord({
        type: 'assistant',
        isApiErrorMessage: true,
        error: 'authentication_failed',
      })
    ).toBe(true);
  });

  it('recognises a record carrying only the isApiErrorMessage marker', () => {
    expect(isApiErrorRecord({ type: 'assistant', isApiErrorMessage: true })).toBe(true);
  });

  it('recognises a record carrying only an error code', () => {
    expect(isApiErrorRecord({ type: 'assistant', error: 'server_error' })).toBe(true);
  });

  it('does not recognise an ordinary assistant record', () => {
    expect(isApiErrorRecord({ type: 'assistant' })).toBe(false);
  });

  // A `system` record in the local corpus carries an OBJECT under `error`.
  // Reading it as a code would classify a record nobody renders as a failure
  // notice, so the type is narrowed and the record kind is checked first.
  it('ignores a non-assistant record even when it carries an error field', () => {
    expect(isApiErrorRecord({ type: 'system', error: { message: 'boom' } })).toBe(false);
  });

  it('ignores an object error on an assistant record', () => {
    expect(isApiErrorRecord({ type: 'assistant', error: { message: 'boom' } })).toBe(false);
  });

  it('ignores an empty-string error code', () => {
    expect(isApiErrorRecord({ type: 'assistant', error: '' })).toBe(false);
  });
});

describe('apiErrorCode', () => {
  it('returns the code from a string error field', () => {
    expect(apiErrorCode({ type: 'assistant', error: 'rate_limit' })).toBe('rate_limit');
  });

  it('returns undefined for a non-string error field', () => {
    expect(apiErrorCode({ type: 'assistant', error: { message: 'boom' } })).toBeUndefined();
  });

  it('returns undefined when no error field is present', () => {
    expect(apiErrorCode({ type: 'assistant', isApiErrorMessage: true })).toBeUndefined();
  });
});

describe('buildApiErrorPart', () => {
  // The one place the auth SENTENCE is pinned by hand rather than derived. Every
  // other test here and in the parser asks `describeAssistantError` what the copy
  // is, so a reword stays a one-line change — but something has to notice the
  // reword, and this is it. If DorkOS's auth copy changes, this test is the
  // deliberate red that says so out loud.
  it('maps an expired sign-in to the auth category with DorkOS copy', () => {
    const part = buildApiErrorPart(
      'authentication_failed',
      'Failed to authenticate: OAuth session expired and could not be refreshed'
    );

    expect(part).toEqual({
      type: 'error',
      message: 'Your Claude sign-in stopped working. Sign in again to keep going.',
      category: 'auth_error',
      details: 'Failed to authenticate: OAuth session expired and could not be refreshed',
    });
  });

  it('maps a disabled-organization sign-in to the auth category', () => {
    const part = buildApiErrorPart(
      'oauth_org_not_allowed',
      'Your organization has disabled Claude subscription access for Claude Code'
    );

    expect(part.category).toBe('auth_error');
    expect(part.details).toBe(
      'Your organization has disabled Claude subscription access for Claude Code'
    );
  });

  it('maps a server error to execution_error with DorkOS copy and the vendor text as details', () => {
    const part = buildApiErrorPart('server_error', 'API Error: 529 Overloaded.');

    expect(part).toEqual({
      type: 'error',
      message: 'Claude encountered a server error. Try again in a moment.',
      category: 'execution_error',
      details: 'API Error: 529 Overloaded.',
    });
  });

  // The live stream deliberately does not surface `rate_limit` as an error
  // event — the rate-limit channel reports it there. Hydration has no such
  // channel, so the notice stays, uncategorised and in the CLI's own words:
  // that is a card the person can read, not a sentence the agent said.
  it('keeps the CLI wording, uncategorised, for a code DorkOS has no copy for', () => {
    const part = buildApiErrorPart(
      'rate_limit',
      "You've hit your weekly limit · resets Aug 24 at 8pm"
    );

    expect(part).toEqual({
      type: 'error',
      message: "You've hit your weekly limit · resets Aug 24 at 8pm",
    });
    expect(part.category).toBeUndefined();
    expect(part.details).toBeUndefined();
  });

  it('does not mistake a rate-limit notice for an auth failure', () => {
    const part = buildApiErrorPart(
      'rate_limit',
      "You've hit your session limit · resets 1:50pm (America/Chicago)"
    );

    expect(part.category).toBeUndefined();
  });

  // A code the SDK has not named yet still reaches the sign-in card when the
  // text is unmistakably a credential failure.
  it('detects an auth failure from the notice text under an unnamed code', () => {
    const part = buildApiErrorPart(
      'unknown',
      'Please run /login · API Error: 401 OAuth access token has been revoked.'
    );

    expect(part.category).toBe('auth_error');
    expect(part.details).toBe(
      'Please run /login · API Error: 401 OAuth access token has been revoked.'
    );
  });

  it('handles a record with no code at all', () => {
    const part = buildApiErrorPart(undefined, 'API Error: Connection dropped (ECONNRESET)');

    expect(part).toEqual({
      type: 'error',
      message: 'API Error: Connection dropped (ECONNRESET)',
    });
  });

  it('omits details when the CLI wrote no text', () => {
    const part = buildApiErrorPart('server_error', '');

    expect(part.details).toBeUndefined();
    expect(part.message).toBe('Claude encountered a server error. Try again in a moment.');
  });

  // Without the fallback this is `message: ''`, which renders a card with a
  // heading and nothing under it.
  it('never yields a blank message when text and copy are both missing', () => {
    expect(buildApiErrorPart('rate_limit', '')).toEqual({
      type: 'error',
      message: 'The agent stopped with an unexpected error.',
    });
    expect(buildApiErrorPart(undefined, '')).toEqual({
      type: 'error',
      message: 'The agent stopped with an unexpected error.',
    });
  });
});
