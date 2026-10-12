/**
 * The stricter bar: with login on, only a person in the cockpit (a session
 * cookie) clears `requireOperatorCookieUnderLogin`.
 *
 * The important cases here are the NEGATIVE ones. A test that only asserted "a
 * cookie works" would pass against a design where a per-user API key satisfies
 * the session gate exactly as a browser session does.
 *
 * Each caller is built as a real Hono context and read with `honoRequestFacts`,
 * exactly as a route asks.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import type { RequestUser } from '../../services/core/auth/session-gate.js';
import { requestFactsFor } from '../../http/__tests__/described-request.js';
import {
  OPERATOR_COOKIE_REQUIRED_CODE,
  isPersonAtTheApp,
  requireOperatorCookieUnderLogin,
} from '../caller-authority.js';

const KEY: RequestUser = { userId: 'user_owner', credential: 'api-key' };
const COOKIE: RequestUser = { userId: 'user_owner', credential: 'cookie' };

describe("on a request's facts", () => {
  describe('requireOperatorCookieUnderLogin', () => {
    it('allows every caller while login is off, because no cookie can exist', async () => {
      const facts = await requestFactsFor({});
      expect(requireOperatorCookieUnderLogin(facts, 'this', () => false)).toBeUndefined();
    });

    it('refuses a caller holding a per-user API key rather than a session', async () => {
      // This is the login-on residual: a program holding a valid key that sheds its
      // agent header satisfies every check that came before this one.
      const refusal = requireOperatorCookieUnderLogin(
        await requestFactsFor({ user: KEY }),
        'this',
        () => true
      );
      expect(refusal?.code).toBe(OPERATOR_COOKIE_REQUIRED_CODE);
      expect(refusal?.status).toBe(403);
    });

    it('refuses a caller the gate resolved no identity for', async () => {
      const refusal = requireOperatorCookieUnderLogin(
        await requestFactsFor({}),
        'this',
        () => true
      );
      expect(refusal?.code).toBe(OPERATOR_COOKIE_REQUIRED_CODE);
    });

    it('allows a person signed in to the cockpit', async () => {
      expect(
        requireOperatorCookieUnderLogin(await requestFactsFor({ user: COOKIE }), 'this', () => true)
      ).toBeUndefined();
    });
  });

  describe('isPersonAtTheApp', () => {
    const window = { 'x-client-id': 'window-1' };
    const off = () => false;
    const on = () => true;

    it('counts a window of the app with login off', async () => {
      expect(isPersonAtTheApp(await requestFactsFor({ headers: window }), off)).toBe(true);
    });

    it('refuses a caller that names itself an agent, even from a window', async () => {
      const agent = await requestFactsFor({ headers: { ...window, 'x-dorkos-agent': 'token' } });
      expect(isPersonAtTheApp(agent, off)).toBe(false);
    });

    it('refuses a script that sends no client id', async () => {
      expect(isPersonAtTheApp(await requestFactsFor({ headers: {} }), off)).toBe(false);
      expect(isPersonAtTheApp(await requestFactsFor({ headers: { 'x-client-id': '' } }), off)).toBe(
        false
      );
    });

    it('refuses an API key under login-on, and counts a browser session', async () => {
      const key = await requestFactsFor({ headers: window, user: KEY });
      const cookie = await requestFactsFor({ headers: window, user: COOKIE });
      expect(isPersonAtTheApp(key, on)).toBe(false);
      expect(isPersonAtTheApp(cookie, on)).toBe(true);
    });
  });
});
