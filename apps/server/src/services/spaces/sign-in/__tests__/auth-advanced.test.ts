import { getIP } from 'better-auth/api';
import { describe, expect, it } from 'vitest';
import { authAdvancedOptions } from '../auth-advanced.js';

// DOR-2552: Better Auth's own rate limiter keys each caller by `getIP`. These run Better Auth's
// real resolver over the options this server hands it.
const addressOf = (trustedProxyHeader: string | undefined, headers: Record<string, string>) =>
  getIP(new Request('https://space.test/api/auth/sign-in/email', { headers }), {
    advanced: authAdvancedOptions({ publicUrl: 'https://space.test', trustedProxyHeader }),
  });

describe('where Better Auth reads a caller address', () => {
  it('reads the trusted proxy header when one is set, so two callers count apart', () => {
    // Fails if the header is not handed to Better Auth: every caller would share one address.
    const first = addressOf('fly-client-ip', { 'fly-client-ip': '198.51.100.1' });
    const second = addressOf('fly-client-ip', { 'fly-client-ip': '198.51.100.2' });
    expect(first).toBe('198.51.100.1');
    expect(second).toBe('198.51.100.2');
  });

  it('ignores that header when no proxy is configured', () => {
    // Fails if the header is honoured without the setting: anyone could pick their own bucket.
    const plain = addressOf(undefined, {});
    expect(addressOf(undefined, { 'fly-client-ip': '203.0.113.9' })).toBe(plain);
    expect(
      authAdvancedOptions({ publicUrl: 'https://space.test', trustedProxyHeader: undefined })
    ).not.toHaveProperty('ipAddress');
  });

  it('keeps the cookie flags tied to the public address', () => {
    const local = authAdvancedOptions({
      publicUrl: 'http://localhost:4300',
      trustedProxyHeader: undefined,
    });
    expect(local).toMatchObject({
      useSecureCookies: false,
      defaultCookieAttributes: { secure: false },
    });
    expect(
      authAdvancedOptions({ publicUrl: 'https://space.test', trustedProxyHeader: undefined })
    ).toMatchObject({
      useSecureCookies: true,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure: true },
    });
  });
});
