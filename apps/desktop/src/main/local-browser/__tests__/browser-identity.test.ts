import { describe, expect, it } from 'vitest';
import { chromeIdentity } from '../browser-identity';

describe('guest browser identity', () => {
  it('uses the real engine version and the reduced desktop UA', () => {
    const identity = chromeIdentity('155.0.8040.2', 'darwin', 'arm64', '26.1.0');
    expect(identity.userAgent).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'
    );
    expect(identity.userAgent).not.toMatch(/electron|dorkos/i);
    expect(identity.userAgentMetadata).toMatchObject({
      brands: [{ brand: 'Chromium', version: '155' }],
      fullVersionList: [{ brand: 'Chromium', version: '155.0.8040.2' }],
      platform: 'macOS',
      platformVersion: '26.1.0',
      architecture: 'arm',
      bitness: '64',
      mobile: false,
    });
    expect(JSON.stringify(identity.userAgentMetadata)).not.toMatch(/Electron|dorkos|Google Chrome/);
  });
  it.each([
    ['win32', 'Windows NT 10.0; Win64; x64', 'Windows'],
    ['linux', 'X11; Linux x86_64', 'Linux'],
  ] as const)('keeps %s platform hints consistent', (platform, ua, hint) => {
    const identity = chromeIdentity('155.0.1.2', platform, 'x64', '10.0.0');
    expect(identity.userAgent).toContain(ua);
    expect(identity.userAgentMetadata.platform).toBe(hint);
  });
});
