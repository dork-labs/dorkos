/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The readers pull from the config store and the auth `user` table; mock both so
// the wiring tests run without a live DB. The pure predicates below need neither.
vi.mock('../../config-manager.js', () => ({
  configManager: { get: vi.fn() },
}));
vi.mock('../index.js', () => ({
  hasAnyUser: vi.fn(),
}));

import {
  isExposureAllowed,
  readExposureState,
  canExpose,
  checkBindAllowed,
  checkA2aExposure,
  AUTH_REQUIRED_FOR_EXPOSURE,
  EXPOSURE_REQUIRES_LOGIN_MESSAGE,
} from '../exposure-guard.js';
import { isLoopbackHost } from '../../../../lib/trusted-origins.js';
import { configManager } from '../../config-manager.js';
import { hasAnyUser } from '../index.js';

const mockConfigGet = vi.mocked(configManager.get) as unknown as ReturnType<typeof vi.fn>;
const mockHasAnyUser = vi.mocked(hasAnyUser);

/** Point the mocked config at an `auth.enabled` value for the `auth` key only. */
function setAuthEnabled(enabled: boolean): void {
  mockConfigGet.mockImplementation((key: string) => (key === 'auth' ? { enabled } : undefined));
}

describe('exposure-guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isExposureAllowed (pure predicate)', () => {
    // ADR 261015-125850 rule 3: exposure needs an owner account, not "Ask for a
    // password on this computer too". The gate asks every other device for a
    // person session whatever that setting says, so what exposure needs is an
    // account those devices can sign in as.
    it('blocks when no owner account exists', () => {
      expect(isExposureAllowed({ hasUsers: false })).toBe(false);
    });
    it('allows once an owner account exists', () => {
      expect(isExposureAllowed({ hasUsers: true })).toBe(true);
    });
  });

  describe('readExposureState + canExpose (wire the user count)', () => {
    it('reads hasUsers from hasAnyUser', () => {
      mockHasAnyUser.mockReturnValue(true);
      expect(readExposureState()).toEqual({ hasUsers: true });
      expect(canExpose()).toBe(true);
    });

    it('canExpose is false when no owner exists, even with the password asked on this computer', () => {
      setAuthEnabled(true);
      mockHasAnyUser.mockReturnValue(false);
      expect(canExpose()).toBe(false);
    });

    it('canExpose is true when an owner exists with the this-computer password off', () => {
      // Under the old switch this blocked; other devices are now asked for a
      // session per request, so the owner alone is enough.
      setAuthEnabled(false);
      mockHasAnyUser.mockReturnValue(true);
      expect(canExpose()).toBe(true);
    });

    it('does not read the auth config section at all', () => {
      mockConfigGet.mockReturnValue(undefined);
      mockHasAnyUser.mockReturnValue(true);
      expect(canExpose()).toBe(true);
      expect(mockConfigGet).not.toHaveBeenCalledWith('auth');
    });
  });

  describe('isLoopbackHost', () => {
    it.each(['localhost', '127.0.0.1', '::1', 'LOCALHOST', ' 127.0.0.1 '])(
      'treats %j as loopback',
      (host) => {
        expect(isLoopbackHost(host)).toBe(true);
      }
    );
    it.each(['0.0.0.0', '192.168.1.10', 'example.com', '::'])(
      'treats %j as non-loopback',
      (host) => {
        expect(isLoopbackHost(host)).toBe(false);
      }
    );
  });

  describe('checkBindAllowed (startup bind refusal — pure, no server bound)', () => {
    it('always allows a loopback host regardless of exposure or escape-hatch', () => {
      expect(
        checkBindAllowed({ host: 'localhost', exposureAllowed: false, allowInsecureBind: false })
      ).toEqual({ allowed: true });
    });

    it('allows a non-loopback host when the exposure guard passes', () => {
      expect(
        checkBindAllowed({ host: '0.0.0.0', exposureAllowed: true, allowInsecureBind: false })
      ).toEqual({ allowed: true });
    });

    it('refuses a non-loopback host with an actionable reason when the guard fails', () => {
      const result = checkBindAllowed({
        host: '0.0.0.0',
        exposureAllowed: false,
        allowInsecureBind: false,
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('0.0.0.0');
      expect(result.reason).toContain('dorkos auth enable');
      expect(result.reason).toContain('DORKOS_ALLOW_INSECURE_BIND');
    });

    it('allows a non-loopback host via the escape hatch, with a warning and no reason', () => {
      const result = checkBindAllowed({
        host: '0.0.0.0',
        exposureAllowed: false,
        allowInsecureBind: true,
      });
      expect(result.allowed).toBe(true);
      expect(result.warning).toContain('DORKOS_ALLOW_INSECURE_BIND');
      expect(result.reason).toBeUndefined();
    });
  });

  describe('checkA2aExposure (A2A gateway mount guard — pure)', () => {
    it('allows a loopback host with no auth configured (local zero-config)', () => {
      expect(
        checkA2aExposure({ host: 'localhost', authConfigured: false, allowInsecureBind: false })
      ).toEqual({ allowed: true });
    });

    it('allows a loopback host regardless of auth', () => {
      expect(
        checkA2aExposure({ host: '127.0.0.1', authConfigured: true, allowInsecureBind: false })
      ).toEqual({ allowed: true });
    });

    it('allows a non-loopback host when auth is configured', () => {
      expect(
        checkA2aExposure({ host: '0.0.0.0', authConfigured: true, allowInsecureBind: false })
      ).toEqual({ allowed: true });
    });

    it('refuses a non-loopback host with no auth, naming both fixes (env key or owner account)', () => {
      const result = checkA2aExposure({
        host: '0.0.0.0',
        authConfigured: false,
        allowInsecureBind: false,
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('0.0.0.0');
      expect(result.reason).toContain('MCP_API_KEY');
      expect(result.reason).toContain('create an owner account');
      expect(result.reason).toContain('DORKOS_ALLOW_INSECURE_BIND');
    });

    it('allows a non-loopback host via the escape hatch, with a warning and no reason', () => {
      const result = checkA2aExposure({
        host: '0.0.0.0',
        authConfigured: false,
        allowInsecureBind: true,
      });
      expect(result.allowed).toBe(true);
      expect(result.warning).toContain('DORKOS_ALLOW_INSECURE_BIND');
      expect(result.reason).toBeUndefined();
    });
  });

  describe('client-facing contract constants', () => {
    it('exposes the AUTH_REQUIRED_FOR_EXPOSURE code and message', () => {
      expect(AUTH_REQUIRED_FOR_EXPOSURE).toBe('AUTH_REQUIRED_FOR_EXPOSURE');
      expect(EXPOSURE_REQUIRES_LOGIN_MESSAGE).toBe(
        'Exposing DorkOS requires a login. Create an owner account first.'
      );
    });
  });
});
