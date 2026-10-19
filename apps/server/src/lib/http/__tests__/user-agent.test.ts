/**
 * A `User-Agent` in a few words, shared by the hub's browser label and the
 * signed-in devices list.
 */
import { describe, expect, it } from 'vitest';
import { describeUserAgent, userAgentPlatform } from '../user-agent.js';

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

describe('userAgentPlatform', () => {
  it('names the platform alone, or nothing', () => {
    expect(userAgentPlatform(UA.iphoneChrome)).toBe('iPhone');
    expect(userAgentPlatform('curl/8.0')).toBeUndefined();
    expect(userAgentPlatform(undefined)).toBeUndefined();
  });
});
