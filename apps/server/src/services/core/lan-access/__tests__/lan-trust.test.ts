import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lan-addresses.js', () => ({ readLanAddresses: () => ['192.168.86.201'] }));

import { getLanAccessOrigins, isLanAccessHost, setLanTrust } from '../lan-trust.js';
import { resolveTrustedOrigins } from '../../../../lib/trusted-origins.js';

afterEach(() => setLanTrust(null));

describe('isLanAccessHost', () => {
  it('matches this computer’s names and addresses, any port, any case', () => {
    setLanTrust({ port: 4242, names: ['studio.local'], secureCookies: true });
    expect(isLanAccessHost('studio.local:4242')).toBe(true);
    expect(isLanAccessHost('STUDIO.local')).toBe(true);
    expect(isLanAccessHost('192.168.86.201:9999')).toBe(true);
  });

  it('matches nothing else, and nothing while closed', () => {
    setLanTrust({ port: 4242, names: ['studio.local'], secureCookies: true });
    expect(isLanAccessHost('studio.local.evil.com')).toBe(false);
    expect(isLanAccessHost('localhost:4242')).toBe(false);
    expect(isLanAccessHost('[::1]:4242')).toBe(false);
    expect(isLanAccessHost('')).toBe(false);
    expect(isLanAccessHost(undefined)).toBe(false);
    setLanTrust(null);
    expect(isLanAccessHost('studio.local:4242')).toBe(false);
  });
});

describe('the trusted origins', () => {
  it('include this computer’s Wi-Fi origins only while Wi-Fi access is open', () => {
    expect(resolveTrustedOrigins()).not.toContain('http://studio.local:4242');
    setLanTrust({ port: 4242, names: ['studio.local'], secureCookies: true });
    expect(getLanAccessOrigins()).toEqual([
      'http://studio.local:4242',
      'http://192.168.86.201:4242',
    ]);
    expect(resolveTrustedOrigins()).toEqual(
      expect.arrayContaining(['http://studio.local:4242', 'http://192.168.86.201:4242'])
    );
    setLanTrust(null);
    expect(resolveTrustedOrigins()).not.toContain('http://studio.local:4242');
  });
});
