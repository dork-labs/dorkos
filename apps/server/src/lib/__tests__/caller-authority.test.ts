/**
 * The stricter bar: which callers may create or widen a standing permission
 * (spec `agent-approval-settings` §3.0).
 *
 * The important cases here are the two NEGATIVE ones. A test that only asserted
 * "a cookie works" would pass against the broken design this guard exists to
 * replace, because under `local-trust` a header-stripping caller clears every
 * check that came before it, and under login-on a per-user API key satisfies the
 * session gate exactly as a browser session does.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import type { Response } from 'express';
import {
  OPERATOR_COOKIE_REQUIRED_CODE,
  STANDING_GRANTS_REQUIRE_LOGIN_CODE,
  requireOperatorCookie,
} from '../caller-authority.js';

/** A response carrying whatever `sessionGate` resolved, or nothing. */
function responseWith(user?: { userId: string; credential: 'cookie' | 'api-key' }): Response {
  return { locals: user ? { user } : {} } as unknown as Response;
}

describe('requireOperatorCookie', () => {
  it('refuses everyone while login is off, because no cookie can exist', () => {
    const refusal = requireOperatorCookie(responseWith(), () => false);
    expect(refusal?.code).toBe(STANDING_GRANTS_REQUIRE_LOGIN_CODE);
    expect(refusal?.status).toBe(403);
    expect(refusal?.error).toMatch(/Require login/);
  });

  it('refuses a caller holding a per-user API key rather than a session', () => {
    // This is the login-on residual: a program holding a valid key that sheds its
    // agent header satisfies every check that came before this one.
    const refusal = requireOperatorCookie(
      responseWith({ userId: 'user_owner', credential: 'api-key' }),
      () => true
    );
    expect(refusal?.code).toBe(OPERATOR_COOKIE_REQUIRED_CODE);
    expect(refusal?.status).toBe(403);
  });

  it('refuses a caller the gate resolved no identity for', () => {
    const refusal = requireOperatorCookie(responseWith(), () => true);
    expect(refusal?.code).toBe(OPERATOR_COOKIE_REQUIRED_CODE);
  });

  it('allows a person signed in to the cockpit', () => {
    expect(
      requireOperatorCookie(
        responseWith({ userId: 'user_owner', credential: 'cookie' }),
        () => true
      )
    ).toBeUndefined();
  });
});
