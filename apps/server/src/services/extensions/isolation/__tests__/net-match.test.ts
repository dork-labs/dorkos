/**
 * The guard's matcher (DOR-2686 task 3.2). It re-implements address parsing
 * on captured built-ins, so it must agree with the shared grammar
 * (`matchesNetEntry`) on every case — and keep agreeing after the
 * prototypes it would naively lean on are rewritten.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { matchesNetEntry } from '@dorkos/extension-api';
import {
  isLocalTarget,
  isLoopbackTarget,
  matchTarget,
  normalizeTarget,
  parseIpv6,
  prepareEntries,
} from '../child/net-match.js';

const ENTRIES = [
  'api.example.com',
  '*.googleapis.com',
  'localhost:8080',
  '10.0.0.5:22',
  '[::1]:3000',
  '[2001:db8::1]',
  'imap.fastmail.com:993',
];

/** Whether the guard's matcher allows host:port. */
function guardAllows(host: string, port: number): boolean {
  const target = normalizeTarget(host);
  return target !== null && matchTarget(prepareEntries(ENTRIES), target, port).matched;
}

const CASES: [string, number][] = [
  ['api.example.com', 443],
  ['API.Example.COM.', 1],
  ['x.api.example.com', 443],
  ['storage.googleapis.com', 443],
  ['a.b.googleapis.com', 80],
  ['googleapis.com', 443],
  ['localhost', 8080],
  ['localhost', 8081],
  ['10.0.0.5', 22],
  ['10.0.0.5', 23],
  ['010.0.0.5', 22],
  ['[::1]', 3000],
  ['0:0::1', 3000],
  ['::1', 3001],
  ['2001:db8:0:0:0:0:0:1', 9],
  ['imap.fastmail.com', 993],
  ['imap.fastmail.com', 143],
  ['127.1', 8080],
  ['', 80],
];

describe('net-match', () => {
  const saved = {
    endsWith: String.prototype.endsWith,
    toLowerCase: String.prototype.toLowerCase,
    slice: String.prototype.slice,
    some: Array.prototype.some,
    includes: Array.prototype.includes,
  };

  afterEach(() => {
    String.prototype.endsWith = saved.endsWith;
    String.prototype.toLowerCase = saved.toLowerCase;
    String.prototype.slice = saved.slice;
    Array.prototype.some = saved.some;
    Array.prototype.includes = saved.includes;
  });

  // Purpose: the guard and the shared grammar give the same answer for every case.
  it.each(CASES)('agrees with matchesNetEntry for %s:%i', (host, port) => {
    expect(guardAllows(host, port)).toBe(matchesNetEntry(ENTRIES, host, port));
  });

  // Purpose: the table above is not all-false or all-true (it can fail).
  it('allows some cases and refuses others', () => {
    const answers = CASES.map(([host, port]) => guardAllows(host, port));
    expect(answers).toContain(true);
    expect(answers).toContain(false);
  });

  // Purpose: after the prototypes are rewritten to say yes, the answers
  // computed BEFORE still come out the same.
  it('keeps its answers after prototype tampering', () => {
    const entries = prepareEntries(ENTRIES);
    const before = CASES.map(([host, port]) => {
      const t = normalizeTarget(host);
      return t !== null && matchTarget(entries, t, port).matched;
    });
    String.prototype.endsWith = () => true;
    String.prototype.toLowerCase = function () {
      return 'api.example.com';
    };
    String.prototype.slice = () => '';
    Array.prototype.some = () => true;
    Array.prototype.includes = () => true;
    const after = CASES.map(([host, port]) => {
      const t = normalizeTarget(host);
      return t !== null && matchTarget(entries, t, port).matched;
    });
    // Restore before asserting, so the test runner itself is not tampered with.
    String.prototype.endsWith = saved.endsWith;
    String.prototype.toLowerCase = saved.toLowerCase;
    String.prototype.slice = saved.slice;
    Array.prototype.some = saved.some;
    Array.prototype.includes = saved.includes;
    expect(after).toEqual(before);
  });

  // Purpose: address classes the rebinding re-check relies on.
  it('classifies loopback, private and public addresses', () => {
    const t = (h: string) => normalizeTarget(h)!;
    expect(isLoopbackTarget(t('127.0.0.1'))).toBe(true);
    expect(isLoopbackTarget(t('0.0.0.0'))).toBe(true);
    expect(isLoopbackTarget(t('::1'))).toBe(true);
    expect(isLoopbackTarget(t('::ffff:127.0.0.1'))).toBe(true);
    expect(isLocalTarget(t('192.168.1.5'))).toBe(true);
    expect(isLocalTarget(t('172.16.0.1'))).toBe(true);
    expect(isLocalTarget(t('100.64.0.1'))).toBe(true);
    expect(isLocalTarget(t('169.254.1.1'))).toBe(true);
    expect(isLocalTarget(t('fd00::1'))).toBe(true);
    expect(isLocalTarget(t('fe80::1'))).toBe(true);
    expect(isLocalTarget(t('::ffff:10.0.0.1'))).toBe(true);
    expect(isLocalTarget(t('64:ff9b::7f00:1'))).toBe(true);
    expect(isLocalTarget(t('93.184.216.34'))).toBe(false);
    expect(isLocalTarget(t('2606:4700::1111'))).toBe(false);
  });

  // Purpose: IPv6 parsing refuses malformed text rather than guessing.
  it('refuses malformed IPv6', () => {
    for (const bad of ['1::2::3', ':1', '1:', '12345::', '1:2:3:4:5:6:7:8:9', 'g::1', '::1.2.3']) {
      expect(parseIpv6(bad)).toBeNull();
    }
    expect(Array.from(parseIpv6('::ffff:1.2.3.4')!)).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
  });
});
