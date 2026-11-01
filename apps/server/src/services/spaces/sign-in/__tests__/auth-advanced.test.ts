import { getIP } from 'better-auth/api';
import { describe, expect, it } from 'vitest';
import { CALLER_ADDRESS_HEADER, withCallerAddressRequest } from '../../caller-address.js';
import { authAdvancedOptions } from '../auth-advanced.js';

// DOR-2552, DOR-2846: Better Auth's own rate limiter keys each caller by `getIP`. These run Better
// Auth's real resolver over the options this server hands it.
const options = { advanced: authAdvancedOptions({ publicUrl: 'https://space.test' }) };
const request = (headers: Record<string, string>) =>
  new Request('https://space.test/api/auth/sign-in/email', { headers });

describe('where Better Auth reads a caller address', () => {
  it('reads the address this server resolved, so two callers count apart', () => {
    // Fails if the server's header is not the one Better Auth reads: every caller would share one.
    const first = getIP(withCallerAddressRequest(request({}), '198.51.100.1'), options);
    const second = getIP(withCallerAddressRequest(request({}), '198.51.100.2'), options);
    expect(first).toBe('198.51.100.1');
    expect(second).toBe('198.51.100.2');
  });

  it('never reads a header the caller chose (DOR-2846)', () => {
    // Fails if X-Forwarded-For (Better Auth's default) or a proxy header is honoured directly:
    // anyone with no proxy in front could send a fresh value and pick their own bucket.
    const plain = getIP(request({}), options);
    expect(getIP(request({ 'x-forwarded-for': '203.0.113.9' }), options)).toBe(plain);
    expect(getIP(request({ 'fly-client-ip': '203.0.113.9' }), options)).toBe(plain);
  });

  it('writes over a caller-address header the caller sent itself', () => {
    // Fails if the caller's own value survives: the private header would be no better than XFF.
    const forged = request({ [CALLER_ADDRESS_HEADER]: '203.0.113.9' });
    expect(getIP(withCallerAddressRequest(forged, '198.51.100.7'), options)).toBe('198.51.100.7');
  });

  it('keeps the cookie flags tied to the public address', () => {
    expect(authAdvancedOptions({ publicUrl: 'http://localhost:4300' })).toMatchObject({
      useSecureCookies: false,
      defaultCookieAttributes: { secure: false },
    });
    expect(authAdvancedOptions({ publicUrl: 'https://space.test' })).toMatchObject({
      useSecureCookies: true,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure: true },
    });
  });
});
