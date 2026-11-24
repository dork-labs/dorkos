/**
 * The sign-in failure copy table (DOR-982): which sentence a person reads, and
 * which failure offers the credentials form.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { describeSigninError, readSigninFailureCode } from '../lib/mcp-signin-errors';

describe('describeSigninError', () => {
  it('offers app credentials only for the provider-will-not-register family', () => {
    const view = describeSigninError({
      message: 'This server won’t let DorkOS register itself. Add your own app credentials.',
      code: 'signin_no_app_registration',
    });

    expect(view.canUseOwnCredentials).toBe(true);
    expect(view.message).toContain('app credentials');
  });

  it('does not offer credentials for a server that publishes no sign-in details', () => {
    const view = describeSigninError({
      message: 'anything',
      code: 'signin_no_signin_support',
    });

    expect(view.canUseOwnCredentials).toBe(false);
    expect(view.message).toContain('doesn’t offer sign-in the way DorkOS expects');
  });

  it('does not offer credentials for an unreachable server', () => {
    const view = describeSigninError({
      message: 'fetch failed',
      code: 'signin_unreachable',
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
    expect(view.canUseOwnCredentials).toBe(false);
  });

  it('ignores a code it does not recognise rather than showing a blank reason', () => {
    // The old SCREAMING spelling is one of them: the server sends problem codes.
    expect(
      describeSigninError({ message: 'Server said no', code: 'SIGNIN_NO_APP_REGISTRATION' })
    ).toEqual({ message: 'Server said no', canUseOwnCredentials: false });

    const view = describeSigninError({ message: 'Server said no', code: 'something_newer' });

    expect(view.message).toBe('Server said no');
    expect(view.canUseOwnCredentials).toBe(false);
  });

  it('has a sentence for nothing at all', () => {
    expect(describeSigninError({ message: null }).message).toBe(
      'Sign-in didn’t finish. Try again.'
    );
  });
});

describe('readSigninFailureCode', () => {
  it('reads the problem code the transport attached', () => {
    const err = Object.assign(new Error('This server won’t let DorkOS register itself.'), {
      code: 'signin_no_app_registration',
    });

    expect(readSigninFailureCode(err)).toBe('signin_no_app_registration');
  });

  it('degrades to nothing for a rejection that carries no code', () => {
    // A dropped request or an abort can arrive as a plain Error.
    expect(readSigninFailureCode(new Error('Failed to fetch'))).toBeUndefined();
    expect(readSigninFailureCode('a string')).toBeUndefined();
    expect(readSigninFailureCode(null)).toBeUndefined();
    expect(readSigninFailureCode(Object.assign(new Error('x'), { code: 7 }))).toBeUndefined();
  });
});
