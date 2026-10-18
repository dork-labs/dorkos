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
  describeUserAgent,
  mintBrowserDeviceId,
} from '../browser-device.js';

const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  androidFirefox: 'Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
};

describe('describeUserAgent', () => {
  it.each([
    [UA.iphoneSafari, 'Safari on iPhone'],
    [UA.iphoneChrome, 'Chrome on iPhone'],
    [UA.macChrome, 'Chrome on Mac'],
    [UA.macSafari, 'Safari on Mac'],
    [UA.windowsEdge, 'Edge on Windows'],
    [UA.androidFirefox, 'Firefox on Android'],
    [UA.linuxFirefox, 'Firefox on Linux'],
    ['curl/8.0', 'A web browser'],
    [undefined, 'A web browser'],
  ])('%s reads as %s', (ua, label) => {
    expect(describeUserAgent(ua)).toBe(label);
  });
});

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
        userAgent: UA.macChrome,
      },
      false
    );
    expect(device).toEqual({ id: 'browser-id-0001', label: 'Chrome on Mac' });
    expect(browserDevice({ cookie: 'better-auth.session_token=tok-secret' }, false)).toBeNull();
  });
});
