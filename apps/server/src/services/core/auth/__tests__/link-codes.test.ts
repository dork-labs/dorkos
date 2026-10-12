/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { startLinkResultFrom } from '../link-codes.js';

const CODES = {
  device_code: 'device',
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://dorkos.ai/activate',
  expires_in: 600,
  interval: 5,
};
const NOW = Date.parse('2026-10-10T12:00:00.000Z');

describe('startLinkResultFrom', () => {
  it('forwards the filled-in address when the service sends one', () => {
    expect(
      startLinkResultFrom(
        { ...CODES, verification_uri_complete: 'https://dorkos.ai/activate?code=ABCD-EFGH' },
        NOW
      )
    ).toEqual({
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://dorkos.ai/activate',
      verificationUriComplete: 'https://dorkos.ai/activate?code=ABCD-EFGH',
      expiresAt: '2026-10-10T12:10:00.000Z',
    });
  });

  it('leaves it out when the service sends none, or one a browser should not open', () => {
    expect(startLinkResultFrom(CODES, NOW)).not.toHaveProperty('verificationUriComplete');
    for (const bad of ['', 'not a url', 'javascript:alert(1)', 'file:///etc/passwd']) {
      expect(
        startLinkResultFrom({ ...CODES, verification_uri_complete: bad }, NOW)
      ).not.toHaveProperty('verificationUriComplete');
    }
  });
});
