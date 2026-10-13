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
    alias: vi.fn(),
    get_property: vi.fn(() => undefined),
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
  prepareInstallCopy,
  resetIdentity,
} from '../analytics';

const mockPosthog = posthog as unknown as {
  capture: ReturnType<typeof vi.fn>;
  alias: ReturnType<typeof vi.fn>;
  get_property: ReturnType<typeof vi.fn>;
  identify: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  has_opted_out_capturing: ReturnType<typeof vi.fn>;
  opt_in_capturing: ReturnType<typeof vi.fn>;
  opt_out_capturing: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPosthog.has_opted_out_capturing.mockReturnValue(false);
  mockPosthog.get_property.mockReturnValue(undefined);
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

describe('prepareInstallCopy (DOR-2862)', () => {
  const CURL = 'curl -fsSL https://dorkos.ai/install | bash';
  const REF_SUFFIX =
    /^curl -fsSL https:\/\/dorkos\.ai\/install \| bash -s -- --ref=([a-z0-9]{12})(\..*)?$/;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adds a fresh ref for an opted-in visitor and records it as a plain property on copy', () => {
    mockPosthog.get_property.mockReturnValue({
      u: 'https://dorkos.ai/blog/post?utm_source=HN&utm_campaign=launch%20week',
    });
    const copy = prepareInstallCopy(CURL, 'curl');

    const match = REF_SUFFIX.exec(copy.text);
    expect(match).not.toBeNull();
    const token = match![1]!;
    expect(copy.text.endsWith(`--ref=${token}.hn.launch-week`)).toBe(true);
    // Nothing is captured until the clipboard write has landed.
    expect(mockPosthog.capture).not.toHaveBeenCalled();

    copy.onCopied();
    expect(mockPosthog.capture).toHaveBeenCalledWith('hero_install_copy', {
      method: 'curl',
      install_ref: token,
    });
  });

  it('never aliases or identifies anyone, even a signed-in (identified) visitor', () => {
    identifyAccount('acct-uuid-123');
    mockPosthog.identify.mockClear();
    const copy = prepareInstallCopy(CURL, 'curl');
    copy.onCopied();

    expect(mockPosthog.alias).not.toHaveBeenCalled();
    expect(mockPosthog.identify).not.toHaveBeenCalled();
    const events = mockPosthog.capture.mock.calls.map(([event]) => event);
    expect(events).toEqual(['hero_install_copy']);
    expect(events).not.toContain('$create_alias');
  });

  it('mints a different ref for every copy', () => {
    expect(prepareInstallCopy(CURL, 'curl').text).not.toBe(prepareInstallCopy(CURL, 'curl').text);
  });

  it('adds a ref to npx, which runs the CLI that records it', () => {
    expect(prepareInstallCopy('npx dorkos@latest', 'npm').text).toMatch(
      /^npx dorkos@latest --ref=[a-z0-9]{12}$/
    );
  });

  it('copies the plain command for a cookieless or declined visitor', () => {
    mockPosthog.has_opted_out_capturing.mockReturnValue(true);
    const copy = prepareInstallCopy(CURL, 'curl');
    expect(copy.text).toBe(CURL);

    copy.onCopied();
    expect(mockPosthog.capture).toHaveBeenCalledWith('hero_install_copy', { method: 'curl' });
  });

  it.each([
    ['Global Privacy Control', { globalPrivacyControl: true }],
    ['Do Not Track', { doNotTrack: '1' }],
  ])(
    'copies the plain command under %s, even before the banner has opted the visitor out',
    (_name, signal) => {
      // PostHog still reads as opted in: the banner has not reconciled yet.
      mockPosthog.has_opted_out_capturing.mockReturnValue(false);
      vi.stubGlobal('navigator', { ...signal });
      expect(prepareInstallCopy(CURL, 'curl').text).toBe(CURL);
    }
  );

  it('copies `npm install -g` unchanged: it runs no DorkOS code that could record a ref', () => {
    const copy = prepareInstallCopy('npm install -g dorkos', 'npm');
    expect(copy.text).toBe('npm install -g dorkos');
    copy.onCopied();
    expect(mockPosthog.capture).toHaveBeenCalledWith('hero_install_copy', { method: 'npm' });
  });
});
