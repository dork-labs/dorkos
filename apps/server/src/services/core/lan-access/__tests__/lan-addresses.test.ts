import { describe, expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { isLocalNetworkPeer, readLanAddresses, toLocalName } from '../lan-addresses.js';

/** One interface entry with the fields the reader looks at. */
function entry(
  address: string,
  family: 'IPv4' | 'IPv6',
  internal = false,
  cidr: string | null = null
): NetworkInterfaceInfo {
  return {
    address,
    family,
    internal,
    netmask: '',
    mac: '00:00:00:00:00:00',
    cidr,
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

describe('isLocalNetworkPeer', () => {
  const interfaces = {
    lo0: [entry('127.0.0.1', 'IPv4', true, '127.0.0.1/8')],
    en0: [
      entry('192.168.86.201', 'IPv4', false, '192.168.86.201/24'),
      entry('2601:600:abcd:1::5', 'IPv6', false, '2601:600:abcd:1::5/64'),
    ],
    // A misreported catch-all subnet must not let the internet in.
    utun9: [entry('10.9.0.2', 'IPv4', false, '10.9.0.2/0')],
  };

  it('lets in a device on the same Wi-Fi, by IPv4, IPv6 or link-local', () => {
    expect(isLocalNetworkPeer('192.168.86.40', interfaces)).toBe(true);
    expect(isLocalNetworkPeer('::ffff:192.168.86.40', interfaces)).toBe(true);
    expect(isLocalNetworkPeer('2601:600:abcd:1::99', interfaces)).toBe(true);
    expect(isLocalNetworkPeer('fe80::1c2b:3a4d%en0', interfaces)).toBe(true);
    expect(isLocalNetworkPeer('::1', interfaces)).toBe(true);
  });

  it('cuts the internet, another network, and anything unreadable', () => {
    expect(isLocalNetworkPeer('8.8.8.8', interfaces)).toBe(false);
    expect(isLocalNetworkPeer('192.168.87.40', interfaces)).toBe(false);
    expect(isLocalNetworkPeer('2a00:1450:4001::1', interfaces)).toBe(false);
    expect(isLocalNetworkPeer('10.9.0.3', interfaces)).toBe(false);
    expect(isLocalNetworkPeer(undefined, interfaces)).toBe(false);
    expect(isLocalNetworkPeer('not-an-address', interfaces)).toBe(false);
  });
});
