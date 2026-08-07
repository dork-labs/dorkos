/**
 * The sign-in failure copy table (DOR-982): which sentence a person reads, what
 * stays behind Details, and which failure offers the credentials form.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { describeSigninError, readSigninFailurePayload } from '../lib/mcp-signin-errors';

describe('describeSigninError', () => {
  it('offers app credentials only for the provider-will-not-register family', () => {
    const view = describeSigninError({
      message: 'HTTP 404: Invalid OAuth error response. Raw body: <html>…',
      code: 'SIGNIN_NO_APP_REGISTRATION',
      detail: 'HTTP 404: Invalid OAuth error response. Raw body: <html>…',
    });

    expect(view.canUseOwnCredentials).toBe(true);
    expect(view.message).toContain('app credentials');
    // The raw text a person cannot act on never becomes the headline.
    expect(view.message).not.toContain('404');
    expect(view.detail).toContain('404');
  });

  it('does not offer credentials for a server that publishes no sign-in details', () => {
    const view = describeSigninError({
      message: 'anything',
      code: 'SIGNIN_NO_SIGNIN_SUPPORT',
      detail: 'anything',
    });

    expect(view.canUseOwnCredentials).toBe(false);
    expect(view.message).toContain('doesn’t offer sign-in the way DorkOS expects');
  });

  it('does not offer credentials for an unreachable server', () => {
    const view = describeSigninError({
      message: 'fetch failed',
      code: 'SIGNIN_UNREACHABLE',
      detail: 'fetch failed',
    });

    expect(view.canUseOwnCredentials).toBe(false);
    expect(view.message).toContain('Couldn’t reach the server');
  });

  it('passes a coded-less message through untouched', () => {
    // The poll path: the server already wrote a plain sentence, and re-wording it
    // here (or blanking it) is how a person loses the only useful thing they had.
    const view = describeSigninError({
      message: 'This sign-in link expired. Please start again.',
    });

    expect(view.message).toBe('This sign-in link expired. Please start again.');
    expect(view.detail).toBeNull();
    expect(view.canUseOwnCredentials).toBe(false);
  });

  it('ignores a code it does not recognise rather than showing a blank reason', () => {
    const view = describeSigninError({ message: 'Server said no', code: 'SOMETHING_NEWER' });

    expect(view.message).toBe('Server said no');
    expect(view.canUseOwnCredentials).toBe(false);
  });

  it('has a sentence for nothing at all', () => {
    expect(describeSigninError({ message: null }).message).toBe('The sign-in did not complete.');
  });
});

describe('readSigninFailurePayload', () => {
  it('reads the code and detail the transport attached', () => {
    const err = Object.assign(new Error('boom'), {
      code: 'SIGNIN_NO_APP_REGISTRATION',
      body: { error: 'boom', code: 'SIGNIN_NO_APP_REGISTRATION', detail: 'HTTP 404' },
    });

    expect(readSigninFailurePayload(err)).toEqual({
      code: 'SIGNIN_NO_APP_REGISTRATION',
      detail: 'HTTP 404',
    });
  });

  it('degrades to nothing for a rejection that carries neither', () => {
    // A dropped request, an abort, an embedded-mode stub — all plain Errors.
    expect(readSigninFailurePayload(new Error('Failed to fetch'))).toEqual({});
    expect(readSigninFailurePayload('a string')).toEqual({});
    expect(readSigninFailurePayload(null)).toEqual({});
    expect(
      readSigninFailurePayload(Object.assign(new Error('x'), { code: 7, body: 'nope' }))
    ).toEqual({});
  });
});
