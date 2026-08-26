import { describe, expect, it } from 'vitest';

import { UNKNOWN_CLIENT_IP, clientIpFromHeaders } from '../client-ip';

describe('clientIpFromHeaders', () => {
  it('prefers x-real-ip over x-forwarded-for', () => {
    const headers = new Headers({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' });
    expect(clientIpFromHeaders(headers)).toBe('203.0.113.7');
  });

  it('falls back to x-forwarded-for when x-real-ip is absent', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '198.51.100.1' }))).toBe(
      '198.51.100.1'
    );
  });

  it('trims surrounding whitespace', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-real-ip': '  203.0.113.7 ' }))).toBe('203.0.113.7');
  });

  it('accepts an IPv6 address', () => {
    const headers = new Headers({ 'x-real-ip': '2001:db8:85a3::8a2e:370:7334' });
    expect(clientIpFromHeaders(headers)).toBe('2001:db8:85a3::8a2e:370:7334');
  });

  it('accepts an IPv4-mapped IPv6 address', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-real-ip': '::ffff:203.0.113.7' }))).toBe(
      '::ffff:203.0.113.7'
    );
  });

  it('returns the shared unknown bucket when no IP header is present', () => {
    expect(clientIpFromHeaders(new Headers())).toBe(UNKNOWN_CLIENT_IP);
  });

  it('returns the shared unknown bucket for an empty header value', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-real-ip': '   ' }))).toBe(UNKNOWN_CLIENT_IP);
  });
});

describe('clientIpFromHeaders refuses what a caller could forge', () => {
  it('rejects a hop list rather than trusting its first element', () => {
    // Off-platform these hops are whatever the caller typed, so mining element
    // zero would hand one abuser an unlimited supply of fresh buckets.
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.42, 70.41.3.18, 150.172.238.178' });
    expect(clientIpFromHeaders(headers)).toBe(UNKNOWN_CLIENT_IP);
  });

  it('rejects a hop list on x-real-ip too', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-real-ip': '203.0.113.42, 70.41.3.18' }))).toBe(
      UNKNOWN_CLIENT_IP
    );
  });

  it('does not let a prepended fake hop escape an exhausted bucket', () => {
    const honest = clientIpFromHeaders(new Headers({ 'x-forwarded-for': '203.0.113.42' }));
    const forged = clientIpFromHeaders(new Headers({ 'x-forwarded-for': '9.9.9.9, 203.0.113.42' }));
    expect(honest).toBe('203.0.113.42');
    expect(forged).not.toBe('9.9.9.9');
    expect(forged).toBe(UNKNOWN_CLIENT_IP);
  });

  it('rejects an oversized header value instead of making it a Map key', () => {
    const huge = '1'.repeat(8192);
    expect(clientIpFromHeaders(new Headers({ 'x-real-ip': huge }))).toBe(UNKNOWN_CLIENT_IP);
  });

  it('rejects a 65-character value and accepts a bounded one', () => {
    const overLong = `${'a'.repeat(60)}:1234`;
    expect(overLong.length).toBe(65);
    expect(clientIpFromHeaders(new Headers({ 'x-real-ip': overLong }))).toBe(UNKNOWN_CLIENT_IP);
    expect(clientIpFromHeaders(new Headers({ 'x-real-ip': `${'a'.repeat(59)}:1234` }))).toBe(
      `${'a'.repeat(59)}:1234`
    );
  });

  it('rejects values that are not IP-shaped at all', () => {
    for (const junk of ['not-an-ip', 'localhost', '<script>', '203.0.113.42:8080', '../../etc']) {
      expect(clientIpFromHeaders(new Headers({ 'x-real-ip': junk }))).toBe(UNKNOWN_CLIENT_IP);
    }
  });

  it('rejects a dotted quad with an out-of-range octet', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-real-ip': '999.0.113.42' }))).toBe(
      UNKNOWN_CLIENT_IP
    );
  });

  it('falls through to x-forwarded-for when x-real-ip is untrustworthy', () => {
    const headers = new Headers({ 'x-real-ip': 'garbage', 'x-forwarded-for': '198.51.100.1' });
    expect(clientIpFromHeaders(headers)).toBe('198.51.100.1');
  });
});
