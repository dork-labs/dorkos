import { describe, expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { readLanAddresses, toLocalName } from '../lan-addresses.js';

/** One interface entry with the fields the reader looks at. */
function entry(address: string, family: 'IPv4' | 'IPv6', internal = false): NetworkInterfaceInfo {
  return {
    address,
    family,
    internal,
    netmask: '',
    mac: '00:00:00:00:00:00',
    cidr: null,
    ...(family === 'IPv6' ? { scopeid: 0 } : {}),
  } as NetworkInterfaceInfo;
}

describe('readLanAddresses', () => {
  it('keeps routable IPv4 and drops loopback, self-assigned and IPv6', () => {
    expect(
      readLanAddresses({
        lo0: [entry('127.0.0.1', 'IPv4', true), entry('::1', 'IPv6', true)],
        en0: [entry('192.168.86.201', 'IPv4'), entry('fe80::1', 'IPv6')],
        en5: [entry('169.254.10.2', 'IPv4')],
        en6: [entry('10.0.0.4', 'IPv4'), entry('192.168.86.201', 'IPv4')],
      })
    ).toEqual(['192.168.86.201', '10.0.0.4']);
  });
});

describe('toLocalName', () => {
  it('turns a computer name into its lower-case .local name', () => {
    expect(toLocalName('DC-MBP-M4-2')).toBe('dc-mbp-m4-2.local');
    expect(toLocalName('Studio.local')).toBe('studio.local');
  });

  it('refuses a name a Bonjour lookup could not answer', () => {
    expect(toLocalName('My Mac')).toBeNull();
    expect(toLocalName('')).toBeNull();
    expect(toLocalName('-studio')).toBeNull();
  });
});
