/**
 * The browser a hub request came from: an id from a cookie of its own, never
 * the sign-in token, and a short label read from the User-Agent.
 */
import { describe, expect, it } from 'vitest';
import {
  browserDevice,
  browserDeviceCookieName,
  browserDeviceId,
  browserDeviceSetCookie,
  mintBrowserDeviceId,
} from '../browser-device.js';

const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

describe('the device cookie', () => {
  it('is __Host- bound and Secure on a Secure build, plain on a development one', () => {
    expect(browserDeviceCookieName(true)).toBe('__Host-dorkos-device');
    expect(browserDeviceSetCookie('abc', true)).toBe(
      '__Host-dorkos-device=abc; Path=/; Max-Age=34560000; HttpOnly; SameSite=Lax; Secure'
    );
    expect(browserDeviceSetCookie('abc', false)).not.toContain('Secure');
  });

  it('mints a fresh random id each time, in the protocol’s shape', () => {
    const a = mintBrowserDeviceId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(mintBrowserDeviceId()).not.toBe(a);
  });

  it('reads only its own cookie, and only an id the protocol accepts', () => {
    const header = 'better-auth.session_token=tok; dorkos-device=browser-id-0001; theme=dark';
    expect(browserDeviceId(header, false)).toBe('browser-id-0001');
    expect(browserDeviceId(header, true)).toBeNull();
    expect(browserDeviceId('dorkos-device=short', false)).toBeNull();
    expect(browserDeviceId('dorkos-device=has%20space%20in', false)).toBeNull();
    expect(browserDeviceId(undefined, false)).toBeNull();
  });

  it('names the device without anything from the sign-in cookie', () => {
    const device = browserDevice(
      {
        cookie: 'better-auth.session_token=tok-secret; dorkos-device=browser-id-0001',
        userAgent: MAC_CHROME,
      },
      false
    );
    expect(device).toEqual({ id: 'browser-id-0001', label: 'Chrome on Mac' });
    expect(browserDevice({ cookie: 'better-auth.session_token=tok-secret' }, false)).toBeNull();
  });
});
