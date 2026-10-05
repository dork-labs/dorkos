import { describe, it, expect } from 'vitest';
import { readContentSecurityPolicyHeaders, stripFrameAncestors } from '../proxy-headers.js';

describe('original CSP field provenance', () => {
  it('retains distinct fields, case-insensitive names, and original joined values', () => {
    const raw = [
      'Content-Security-Policy',
      "frame-ancestors 'none'",
      'X-Other',
      'ignored',
      'content-security-policy',
      "script-src 'none'",
      'CONTENT-SECURITY-POLICY',
      "script-src 'unsafe-inline', script-src 'none'",
      'Content-Security-Policy-Report-Only',
      "script-src 'none'",
    ];
    expect(readContentSecurityPolicyHeaders(raw, 'content-security-policy')).toEqual([
      "frame-ancestors 'none'",
      "script-src 'none'",
      "script-src 'unsafe-inline', script-src 'none'",
    ]);
    expect(readContentSecurityPolicyHeaders(raw, 'content-security-policy-report-only')).toEqual([
      "script-src 'none'",
    ]);
    expect(readContentSecurityPolicyHeaders([], 'content-security-policy')).toEqual([]);
  });
});

describe('policy-local framing cleanup', () => {
  it.each([
    ["frame-ancestors 'none', script-src 'none'", "script-src 'none'"],
    ["script-src 'none', frame-ancestors 'none'", "script-src 'none'"],
    [
      "frame-ancestors 'none'; img-src 'self', script-src 'none'; frame-ancestors 'self'; connect-src https://example.com",
      "img-src 'self', script-src 'none'; connect-src https://example.com",
    ],
    [
      "FRAME-ANCESTORS 'none'; script-src 'unsafe-inline', default-src 'self'; script-src 'none'",
      "script-src 'unsafe-inline', default-src 'self'; script-src 'none'",
    ],
    ["frame-ancestors 'none', frame-ancestors 'self'", null],
    [
      "frame-ancestors-report 'none'; script-src 'none'",
      "frame-ancestors-report 'none'; script-src 'none'",
    ],
    ["frame-ancestors 'invalid, script-src 'none'", "frame-ancestors 'invalid, script-src 'none'"],
    ['frame-ancestors "invalid, script-src none"', 'frame-ancestors "invalid, script-src none"'],
    [
      "frame-ancestors 'none'; script-src https://example.com/a,b",
      'script-src https://example.com/a, b',
    ],
  ])('preserves nonframing restrictions in %s', (input, expected) => {
    expect(stripFrameAncestors(input)).toBe(expected);
  });
});
