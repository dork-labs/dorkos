import { describe, expect, it } from 'vitest';

import { UNKNOWN_CLIENT_IP, clientIpFromHeaders } from '../client-ip';

describe('clientIpFromHeaders', () => {
  it('takes the first hop of x-forwarded-for', () => {
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.42, 70.41.3.18, 150.172.238.178' });
    expect(clientIpFromHeaders(headers)).toBe('203.0.113.42');
  });

  it('trims surrounding whitespace', () => {
    expect(
      clientIpFromHeaders(new Headers({ 'x-forwarded-for': '  203.0.113.42 , 70.41.3.18' }))
    ).toBe('203.0.113.42');
  });

  it('falls back to x-real-ip when x-forwarded-for is absent', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-real-ip': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('falls back to x-real-ip when x-forwarded-for is empty', () => {
    const headers = new Headers({ 'x-forwarded-for': '  ', 'x-real-ip': '203.0.113.7' });
    expect(clientIpFromHeaders(headers)).toBe('203.0.113.7');
  });

  it('returns the shared unknown bucket when no IP header is present', () => {
    expect(clientIpFromHeaders(new Headers())).toBe(UNKNOWN_CLIENT_IP);
  });
});
