/**
 * @vitest-environment jsdom
 *
 * Analytics is DISABLED here (no project key), so every helper must be a total
 * no-op: no posthog-js call, matching the "unconfigured deploy makes zero
 * PostHog requests" stance the /privacy page promises.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_POSTHOG_KEY: undefined,
    NEXT_PUBLIC_POSTHOG_HOST: 'https://us.i.posthog.com',
  },
}));

vi.mock('posthog-js', () => ({
  default: {
    identify: vi.fn(),
    reset: vi.fn(),
    has_opted_out_capturing: vi.fn(() => false),
    opt_in_capturing: vi.fn(),
    opt_out_capturing: vi.fn(),
  },
}));

import posthog from 'posthog-js';

import { identifyAccount, resetIdentity } from '../analytics';

const mockPosthog = posthog as unknown as {
  identify: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
};

describe('analytics helpers when disabled', () => {
  it('identifyAccount and resetIdentity make no posthog-js calls', () => {
    identifyAccount('acct-uuid-123');
    resetIdentity();
    expect(mockPosthog.identify).not.toHaveBeenCalled();
    expect(mockPosthog.reset).not.toHaveBeenCalled();
  });
});
