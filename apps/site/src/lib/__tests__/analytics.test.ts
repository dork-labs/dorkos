/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Analytics is enabled here: a project key is configured, so every helper runs
// against the mocked posthog-js singleton below.
vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_POSTHOG_KEY: 'phc_test_key',
    NEXT_PUBLIC_POSTHOG_HOST: 'https://us.i.posthog.com',
  },
}));

vi.mock('posthog-js', () => ({
  default: {
    capture: vi.fn(),
    identify: vi.fn(),
    reset: vi.fn(),
    has_opted_out_capturing: vi.fn(() => false),
    opt_in_capturing: vi.fn(),
    opt_out_capturing: vi.fn(),
  },
}));

import posthog from 'posthog-js';

import {
  CONSENT_CHANGED_EVENT,
  identifyAccount,
  optInCapturing,
  optOutCapturing,
  resetIdentity,
} from '../analytics';

const mockPosthog = posthog as unknown as {
  identify: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  has_opted_out_capturing: ReturnType<typeof vi.fn>;
  opt_in_capturing: ReturnType<typeof vi.fn>;
  opt_out_capturing: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPosthog.has_opted_out_capturing.mockReturnValue(false);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('identifyAccount', () => {
  it('identifies by the account UUID with only an is_account flag (no PII) when opted in', () => {
    mockPosthog.has_opted_out_capturing.mockReturnValue(false);
    identifyAccount('acct-uuid-123');

    expect(mockPosthog.identify).toHaveBeenCalledTimes(1);
    const [distinctId, props] = mockPosthog.identify.mock.calls[0];
    expect(distinctId).toBe('acct-uuid-123');
    expect(props).toEqual({ $set: { is_account: true } });
    // The set payload must never carry email/name/username.
    const setKeys = Object.keys((props as { $set: Record<string, unknown> }).$set);
    expect(setKeys).not.toContain('email');
    expect(setKeys).not.toContain('name');
    expect(setKeys).not.toContain('username');
  });

  it('no-ops when the visitor is opted out (declined / cookieless floor)', () => {
    mockPosthog.has_opted_out_capturing.mockReturnValue(true);
    identifyAccount('acct-uuid-123');
    expect(mockPosthog.identify).not.toHaveBeenCalled();
  });
});

describe('resetIdentity', () => {
  it('resets PostHog identity (logout hygiene)', () => {
    resetIdentity();
    expect(mockPosthog.reset).toHaveBeenCalledTimes(1);
  });
});

describe('consent-change notification', () => {
  it('dispatches CONSENT_CHANGED_EVENT on opt in and opt out', () => {
    const listener = vi.fn();
    window.addEventListener(CONSENT_CHANGED_EVENT, listener);

    optInCapturing({ captureEventName: false });
    optOutCapturing();

    expect(mockPosthog.opt_in_capturing).toHaveBeenCalledTimes(1);
    expect(mockPosthog.opt_out_capturing).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(2);

    window.removeEventListener(CONSENT_CHANGED_EVENT, listener);
  });
});
