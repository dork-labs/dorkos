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
  isLoopbackHost,
  checkBindAllowed,
  AUTH_REQUIRED_FOR_EXPOSURE,
  EXPOSURE_REQUIRES_LOGIN_MESSAGE,
} from '../exposure-guard.js';
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

  describe('isExposureAllowed (pure predicate — all four combinations)', () => {
    it('blocks when auth is off and no users exist', () => {
      expect(isExposureAllowed({ authEnabled: false, hasUsers: false })).toBe(false);
    });
    it('blocks when auth is off even if users exist', () => {
      expect(isExposureAllowed({ authEnabled: false, hasUsers: true })).toBe(false);
    });
    it('blocks when auth is on but no users exist', () => {
      expect(isExposureAllowed({ authEnabled: true, hasUsers: false })).toBe(false);
    });
    it('allows only when auth is on and an owner exists', () => {
      expect(isExposureAllowed({ authEnabled: true, hasUsers: true })).toBe(true);
    });
  });

  describe('readExposureState + canExpose (wire config + user count)', () => {
    it('reads authEnabled from config.auth.enabled and hasUsers from hasAnyUser', () => {
      setAuthEnabled(true);
      mockHasAnyUser.mockReturnValue(true);
      expect(readExposureState()).toEqual({ authEnabled: true, hasUsers: true });
      expect(canExpose()).toBe(true);
    });

    it('canExpose is false when login is enabled but no owner exists', () => {
      setAuthEnabled(true);
      mockHasAnyUser.mockReturnValue(false);
      expect(canExpose()).toBe(false);
    });

    it('canExpose is false when an owner exists but login is disabled', () => {
      setAuthEnabled(false);
      mockHasAnyUser.mockReturnValue(true);
      expect(canExpose()).toBe(false);
    });

    it('treats a missing auth config section as disabled', () => {
      mockConfigGet.mockReturnValue(undefined);
      mockHasAnyUser.mockReturnValue(true);
      expect(readExposureState().authEnabled).toBe(false);
      expect(canExpose()).toBe(false);
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

  describe('client-facing contract constants', () => {
    it('exposes the AUTH_REQUIRED_FOR_EXPOSURE code and message', () => {
      expect(AUTH_REQUIRED_FOR_EXPOSURE).toBe('AUTH_REQUIRED_FOR_EXPOSURE');
      expect(EXPOSURE_REQUIRES_LOGIN_MESSAGE).toBe(
        'Exposing DorkOS requires a login. Create an owner account first.'
      );
    });
  });
});
