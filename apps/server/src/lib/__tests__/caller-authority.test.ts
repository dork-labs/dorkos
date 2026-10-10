/**
 * The stricter bar: with login on, only a person in the cockpit (a session
 * cookie) clears `requireOperatorCookieUnderLogin`.
 *
 * The important cases here are the NEGATIVE ones. A test that only asserted "a
 * cookie works" would pass against a design where a per-user API key satisfies
 * the session gate exactly as a browser session does.
 *
 * Each case runs once per chain (DOR-2794): the caller is built as an Express
 * request and as a Hono context, and both must be judged alike. The Express
 * request-and-response forms the unmoved routes still call are checked last.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import type { Response } from 'express';
import type { RequestUser } from '../../services/core/auth/session-gate.js';
import { REQUEST_FACTS_ADAPTERS } from '../../http/__tests__/request-facts-adapters.js';
import {
  OPERATOR_COOKIE_REQUIRED_CODE,
  isPersonAtTheApp,
  requireOperatorCookieUnderLogin,
} from '../caller-authority.js';

const KEY: RequestUser = { userId: 'user_owner', credential: 'api-key' };
const COOKIE: RequestUser = { userId: 'user_owner', credential: 'cookie' };

describe.each(REQUEST_FACTS_ADAPTERS)('through the $name adapter', (adapter) => {
  describe('requireOperatorCookieUnderLogin', () => {
    it('allows every caller while login is off, because no cookie can exist', async () => {
      const facts = await adapter.facts({});
      expect(requireOperatorCookieUnderLogin(facts, 'this', () => false)).toBeUndefined();
    });

    it('refuses a caller holding a per-user API key rather than a session', async () => {
      // This is the login-on residual: a program holding a valid key that sheds its
      // agent header satisfies every check that came before this one.
      const refusal = requireOperatorCookieUnderLogin(
        await adapter.facts({ user: KEY }),
        'this',
        () => true
      );
      expect(refusal?.code).toBe(OPERATOR_COOKIE_REQUIRED_CODE);
      expect(refusal?.status).toBe(403);
    });

    it('refuses a caller the gate resolved no identity for', async () => {
      const refusal = requireOperatorCookieUnderLogin(await adapter.facts({}), 'this', () => true);
      expect(refusal?.code).toBe(OPERATOR_COOKIE_REQUIRED_CODE);
    });

    it('allows a person signed in to the cockpit', async () => {
      expect(
        requireOperatorCookieUnderLogin(await adapter.facts({ user: COOKIE }), 'this', () => true)
      ).toBeUndefined();
    });
  });

  describe('isPersonAtTheApp', () => {
    const window = { 'x-client-id': 'window-1' };
    const off = () => false;
    const on = () => true;

    it('counts a window of the app with login off', async () => {
      expect(isPersonAtTheApp(await adapter.facts({ headers: window }), off)).toBe(true);
    });

    it('refuses a caller that names itself an agent, even from a window', async () => {
      const agent = await adapter.facts({ headers: { ...window, 'x-dorkos-agent': 'token' } });
      expect(isPersonAtTheApp(agent, off)).toBe(false);
    });

    it('refuses a script that sends no client id', async () => {
      expect(isPersonAtTheApp(await adapter.facts({ headers: {} }), off)).toBe(false);
      expect(isPersonAtTheApp(await adapter.facts({ headers: { 'x-client-id': '' } }), off)).toBe(
        false
      );
    });

    it('refuses an API key under login-on, and counts a browser session', async () => {
      const key = await adapter.facts({ headers: window, user: KEY });
      const cookie = await adapter.facts({ headers: window, user: COOKIE });
      expect(isPersonAtTheApp(key, on)).toBe(false);
      expect(isPersonAtTheApp(cookie, on)).toBe(true);
    });
  });
});

describe('the Express forms the unmoved routes call', () => {
  /** A response carrying whatever `sessionGate` and the agent middleware resolved. */
  function responseWith(user?: RequestUser, agentIdentity?: unknown): Response {
    return {
      locals: { ...(user ? { user } : {}), ...(agentIdentity ? { agentIdentity } : {}) },
    } as unknown as Response;
  }

  describe('requireOperatorCookieUnderLogin', () => {
    it('allows every caller while login is off', () => {
      expect(requireOperatorCookieUnderLogin(responseWith(), 'this', () => false)).toBeUndefined();
    });

    it('refuses a per-user API key, and a caller with no identity', () => {
      expect(requireOperatorCookieUnderLogin(responseWith(KEY), 'this', () => true)?.code).toBe(
        OPERATOR_COOKIE_REQUIRED_CODE
      );
      expect(requireOperatorCookieUnderLogin(responseWith(), 'this', () => true)?.status).toBe(403);
    });

    it('allows a person signed in to the cockpit', () => {
      expect(
        requireOperatorCookieUnderLogin(responseWith(COOKIE), 'this', () => true)
      ).toBeUndefined();
    });
  });

  describe('isPersonAtTheApp', () => {
    const app = { headers: { 'x-client-id': 'window-1' } };
    const off = () => false;
    const on = () => true;

    it('counts a window of the app with login off', () => {
      expect(isPersonAtTheApp(app, responseWith(), off)).toBe(true);
    });

    it('refuses a caller that names itself an agent, by header or as resolved', () => {
      const agent = { headers: { 'x-client-id': 'window-1', 'x-dorkos-agent': 'token' } };
      expect(isPersonAtTheApp(agent, responseWith(), off)).toBe(false);
      expect(isPersonAtTheApp(app, responseWith(undefined, { agentId: 'a' }), off)).toBe(false);
    });

    it('refuses a script that sends no client id', () => {
      expect(isPersonAtTheApp({ headers: {} }, responseWith(), off)).toBe(false);
      expect(isPersonAtTheApp({ headers: { 'x-client-id': '' } }, responseWith(), off)).toBe(false);
    });

    it('refuses an API key under login-on, and counts a browser session', () => {
      expect(isPersonAtTheApp(app, responseWith(KEY), on)).toBe(false);
      expect(isPersonAtTheApp(app, responseWith(COOKIE), on)).toBe(true);
    });
  });
});
