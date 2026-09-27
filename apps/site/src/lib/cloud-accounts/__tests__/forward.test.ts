import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cloudAccountsForwarding,
  decideCloudAccountsForward,
  isCloudAccountPath,
  parseCloudAccountsOrigin,
  PROXIED_ADDRESS_HEADER,
  PROXY_SECRET_HEADER,
  proxiedRequestHeaders,
  usableProxySecret,
  type ForwardableRequest,
} from '../forward';

const SERVICE = 'https://accounts.example.test';

function req(
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {}
): ForwardableRequest {
  return {
    method: init.method ?? 'GET',
    url: `https://site.example.test${path}`,
    headers: new Headers(init.headers ?? {}),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseCloudAccountsOrigin', () => {
  it('is off when unset or blank', () => {
    expect(parseCloudAccountsOrigin(undefined)).toBeNull();
    expect(parseCloudAccountsOrigin('')).toBeNull();
    expect(parseCloudAccountsOrigin('   ')).toBeNull();
  });

  it('reduces a value to its bare origin', () => {
    expect(parseCloudAccountsOrigin(SERVICE)).toBe(SERVICE);
    expect(parseCloudAccountsOrigin(`${SERVICE}/`)).toBe(SERVICE);
    expect(parseCloudAccountsOrigin('HTTPS://Accounts.Example.Test')).toBe(SERVICE);
  });

  it('is off, with a console line, for a value that is not a URL', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseCloudAccountsOrigin('accounts.example.test')).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('is off for plain http unless the host is loopback', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseCloudAccountsOrigin('http://accounts.example.test')).toBeNull();
    expect(parseCloudAccountsOrigin('http://localhost:6255')).toBe('http://localhost:6255');
    expect(parseCloudAccountsOrigin('http://127.0.0.1:6255')).toBe('http://127.0.0.1:6255');
    expect(parseCloudAccountsOrigin('http://[::1]:6255')).toBe('http://[::1]:6255');
  });

  it('refuses a value with a path, a query or credentials rather than trimming it', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseCloudAccountsOrigin(`${SERVICE}/base`)).toBeNull();
    expect(parseCloudAccountsOrigin(`${SERVICE}/?x=1`)).toBeNull();
    expect(parseCloudAccountsOrigin('https://user:pass@accounts.example.test')).toBeNull();
  });

  it('reports a bad value once, not on every request', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    parseCloudAccountsOrigin('not-a-url-reported-once');
    parseCloudAccountsOrigin('not-a-url-reported-once');
    parseCloudAccountsOrigin('not-a-url-reported-once');
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('never logs the value itself', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    parseCloudAccountsOrigin('not a url with-a-secret-looking-token');
    expect(String(error.mock.calls[0]?.[0])).not.toContain('secret-looking');
  });
});

describe('isCloudAccountPath', () => {
  it.each([
    '/signin',
    '/signup',
    '/reset-password',
    '/reset-password/confirm',
    '/verify-email',
    '/activate',
    '/account',
    '/account/instances',
    '/admin',
    '/admin/users',
    '/api/auth/device/code',
    '/api/auth/device/token',
    '/api/auth/get-session',
    '/api/auth/callback/github',
    '/api/account/export',
    '/api/instances',
    '/api/instances/heartbeat',
    '/api/instances/pending',
    '/api/instances/revoke',
    '/api/instances/heartbeat/',
    '/api/instances/',
    '/signin/',
  ])('%s belongs to the account surface', (path) => {
    expect(isCloudAccountPath(path)).toBe(true);
  });

  it.each([
    '/',
    '/accounts',
    '/administrator',
    '/signin-help',
    '/docs/account',
    '/api/instances/connectors/catalog',
    '/api/instances/connectors/events/pull',
    '/api/instances/heartbeat/extra',
    '/api/connectors/managed/webhook',
    '/connectors/managed/authorize',
    '/api/feedback',
    '/api/cron/instance-expiry',
    '/api/telemetry/heartbeat',
  ])('%s stays on the site', (path) => {
    expect(isCloudAccountPath(path)).toBe(false);
  });
});

describe('decideCloudAccountsForward', () => {
  it('forwards nothing when the variable is off', () => {
    expect(decideCloudAccountsForward(req('/signin'), null)).toBeNull();
    expect(
      decideCloudAccountsForward(req('/api/instances/heartbeat', { method: 'POST' }), null)
    ).toBeNull();
  });

  it('forwards nothing outside the account surface', () => {
    expect(decideCloudAccountsForward(req('/blog'), SERVICE)).toBeNull();
    expect(
      decideCloudAccountsForward(
        req('/api/instances/connectors/events/pull', {
          method: 'POST',
          headers: { authorization: 'Bearer t' },
        }),
        SERVICE
      )
    ).toBeNull();
  });

  it('redirects the activation link a released CLI prints, keeping the code', () => {
    const decision = decideCloudAccountsForward(req('/activate?user_code=ABCD-EFGH'), SERVICE);
    expect(decision?.kind).toBe('redirect');
    expect(decision?.url.toString()).toBe(`${SERVICE}/activate?user_code=ABCD-EFGH`);
  });

  it('redirects every account page, even when fetched by the client router', () => {
    for (const path of ['/signin', '/account/instances', '/admin', '/reset-password/confirm']) {
      const decision = decideCloudAccountsForward(
        req(`${path}?_rsc=abc&next=%2Faccount`, { headers: { 'sec-fetch-mode': 'cors' } }),
        SERVICE
      );
      expect(decision?.kind).toBe('redirect');
      // The client router's cache-busting parameter is dropped; the rest stays.
      expect(decision?.url.toString()).toBe(`${SERVICE}${path}?next=%2Faccount`);
    }
  });

  it('proxies a device-code request, which has a body and no bearer', () => {
    const decision = decideCloudAccountsForward(
      req('/api/auth/device/code', { method: 'POST' }),
      SERVICE
    );
    expect(decision).toEqual({ kind: 'proxy', url: new URL(`${SERVICE}/api/auth/device/code`) });
  });

  it('proxies a heartbeat, which carries a bearer the redirect would drop', () => {
    const decision = decideCloudAccountsForward(
      req('/api/instances/heartbeat', { method: 'POST', headers: { authorization: 'Bearer t' } }),
      SERVICE
    );
    expect(decision?.kind).toBe('proxy');
  });

  it('proxies a bearer GET', () => {
    const decision = decideCloudAccountsForward(
      req('/api/auth/get-session', { headers: { authorization: 'Bearer t' } }),
      SERVICE
    );
    expect(decision?.kind).toBe('proxy');
  });

  it("proxies a browser page's background fetch rather than redirecting it cross-origin", () => {
    const decision = decideCloudAccountsForward(
      req('/api/auth/get-session', { headers: { 'sec-fetch-mode': 'cors' } }),
      SERVICE
    );
    expect(decision?.kind).toBe('proxy');
  });

  it('redirects a browser following an email link, so the cookie lands on the service', () => {
    const decision = decideCloudAccountsForward(
      req('/api/auth/verify-email?token=t&callbackURL=%2Faccount', {
        headers: { 'sec-fetch-mode': 'navigate' },
      }),
      SERVICE
    );
    expect(decision?.kind).toBe('redirect');
    expect(decision?.url.toString()).toBe(
      `${SERVICE}/api/auth/verify-email?token=t&callbackURL=%2Faccount`
    );
  });

  it('redirects a plain GET that says nothing about its fetch mode', () => {
    expect(decideCloudAccountsForward(req('/api/account/export'), SERVICE)?.kind).toBe('redirect');
    expect(
      decideCloudAccountsForward(req('/api/instances', { method: 'HEAD' }), SERVICE)?.kind
    ).toBe('redirect');
  });

  it('never forwards a request to the origin it arrived on', () => {
    expect(decideCloudAccountsForward(req('/signin'), 'https://site.example.test')).toBeNull();
  });
});

describe('cloudAccountsForwarding', () => {
  it('follows the variable', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(cloudAccountsForwarding(undefined)).toBe(false);
    expect(cloudAccountsForwarding('nonsense')).toBe(false);
    expect(cloudAccountsForwarding(SERVICE)).toBe(true);
  });
});

describe('proxiedRequestHeaders', () => {
  const SECRET = 'k'.repeat(40);
  const on = { secret: SECRET, onVercel: true };

  it('reports the caller’s platform-set address, with the secret, on Vercel', () => {
    const out = proxiedRequestHeaders(
      new Headers({ 'x-real-ip': '198.51.100.7', accept: '*/*' }),
      on
    );
    expect(out?.get(PROXIED_ADDRESS_HEADER)).toBe('198.51.100.7');
    expect(out?.get(PROXY_SECRET_HEADER)).toBe(SECRET);
    expect(out?.get('accept')).toBe('*/*');
  });

  it('changes nothing when the secret is unset, or too short to be one', () => {
    const headers = new Headers({ 'x-real-ip': '198.51.100.7' });
    expect(proxiedRequestHeaders(headers, { secret: undefined, onVercel: true })).toBeNull();
    expect(proxiedRequestHeaders(headers, { secret: '', onVercel: true })).toBeNull();
    expect(proxiedRequestHeaders(headers, { secret: 'k'.repeat(31), onVercel: true })).toBeNull();
  });

  it('accepts a secret of exactly the minimum length, and trims a pasted newline', () => {
    const headers = new Headers({ 'x-real-ip': '198.51.100.7' });
    const exact = 'k'.repeat(32);
    expect(
      proxiedRequestHeaders(headers, { secret: exact, onVercel: true })?.get(PROXY_SECRET_HEADER)
    ).toBe(exact);
    expect(
      proxiedRequestHeaders(headers, { secret: `  ${exact}\n`, onVercel: true })?.get(
        PROXY_SECRET_HEADER
      )
    ).toBe(exact);
  });

  it('treats a secret a header cannot carry as unset, instead of failing every request', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const headers = new Headers({ 'x-real-ip': '198.51.100.7' });
    for (const bad of [`${'k'.repeat(20)}\n${'k'.repeat(20)}`, `${'k'.repeat(40)}\u201c`]) {
      expect(usableProxySecret(bad)).toBeNull();
      expect(() => proxiedRequestHeaders(headers, { secret: bad, onVercel: true })).not.toThrow();
      expect(proxiedRequestHeaders(headers, { secret: bad, onVercel: true })).toBeNull();
    }
    expect(error.mock.calls.length).toBeGreaterThan(0);
    for (const call of error.mock.calls) {
      expect(call).toEqual([
        'DORKOS_CLOUD_ACCOUNTS_PROXY_SECRET has characters a header cannot carry; not sending it.',
      ]);
    }
  });

  it('vouches for nothing off Vercel, where the address header is whatever the caller sent', () => {
    const headers = new Headers({ 'x-real-ip': '198.51.100.7' });
    expect(proxiedRequestHeaders(headers, { secret: SECRET, onVercel: false })).toBeNull();
  });

  it('vouches for nothing when there is no single address to report', () => {
    for (const headers of [
      new Headers(),
      new Headers({ 'x-real-ip': 'not-an-address' }),
      new Headers({ 'x-forwarded-for': '198.51.100.7, 10.0.0.1' }),
    ]) {
      expect(proxiedRequestHeaders(headers, on)).toBeNull();
    }
  });

  it('always strips a copy of either header the caller sent itself', () => {
    const spoofed = new Headers({
      [PROXIED_ADDRESS_HEADER]: '203.0.113.9',
      [PROXY_SECRET_HEADER]: 'guess',
    });
    for (const options of [
      { secret: undefined, onVercel: false },
      { secret: SECRET, onVercel: false },
      { secret: SECRET, onVercel: true },
    ]) {
      const out = proxiedRequestHeaders(spoofed, options);
      expect(out?.has(PROXIED_ADDRESS_HEADER)).toBe(false);
      expect(out?.has(PROXY_SECRET_HEADER)).toBe(false);
    }
    // And with a real address to report, the site's value replaces the caller's.
    spoofed.set('x-real-ip', '198.51.100.7');
    const out = proxiedRequestHeaders(spoofed, on);
    expect(out?.get(PROXIED_ADDRESS_HEADER)).toBe('198.51.100.7');
    expect(out?.get(PROXY_SECRET_HEADER)).toBe(SECRET);
  });

  it('does not change the headers it was given', () => {
    const headers = new Headers({ 'x-real-ip': '198.51.100.7' });
    proxiedRequestHeaders(headers, on);
    expect(headers.has(PROXY_SECRET_HEADER)).toBe(false);
  });
});
