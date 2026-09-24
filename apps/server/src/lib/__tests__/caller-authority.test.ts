/**
 * The stricter bar: with login on, only a person in the cockpit (a session
 * cookie) clears `requireOperatorCookieUnderLogin`.
 *
 * The important cases here are the NEGATIVE ones. A test that only asserted "a
 * cookie works" would pass against a design where a per-user API key satisfies
 * the session gate exactly as a browser session does.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import type { Response } from 'express';
import {
  OPERATOR_COOKIE_REQUIRED_CODE,
  requireOperatorCookieUnderLogin,
} from '../caller-authority.js';

/** A response carrying whatever `sessionGate` resolved, or nothing. */
function responseWith(user?: { userId: string; credential: 'cookie' | 'api-key' }): Response {
  return { locals: user ? { user } : {} } as unknown as Response;
}

describe('requireOperatorCookieUnderLogin', () => {
  it('allows every caller while login is off, because no cookie can exist', () => {
    expect(requireOperatorCookieUnderLogin(responseWith(), 'this', () => false)).toBeUndefined();
  });

  it('refuses a caller holding a per-user API key rather than a session', () => {
    // This is the login-on residual: a program holding a valid key that sheds its
    // agent header satisfies every check that came before this one.
    const refusal = requireOperatorCookieUnderLogin(
      responseWith({ userId: 'user_owner', credential: 'api-key' }),
      'this',
      () => true
    );
    expect(refusal?.code).toBe(OPERATOR_COOKIE_REQUIRED_CODE);
    expect(refusal?.status).toBe(403);
  });

  it('refuses a caller the gate resolved no identity for', () => {
    const refusal = requireOperatorCookieUnderLogin(responseWith(), 'this', () => true);
    expect(refusal?.code).toBe(OPERATOR_COOKIE_REQUIRED_CODE);
  });

  it('allows a person signed in to the cockpit', () => {
    expect(
      requireOperatorCookieUnderLogin(
        responseWith({ userId: 'user_owner', credential: 'cookie' }),
        'this',
        () => true
      )
    ).toBeUndefined();
  });
});
