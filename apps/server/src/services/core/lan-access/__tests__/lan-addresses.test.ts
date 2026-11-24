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

  it('lets in a device on the same network, by IPv4, IPv6 or link-local', () => {
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

  // DOR-5135: Tailscale gives this computer one address (a /32) in 100.64.0.0/10,
  // and every other device on the tailnet has its own address in that range.
  describe('on a VPN such as Tailscale', () => {
    const withTailnet = {
      ...interfaces,
      utun2: [
        entry('100.118.147.2', 'IPv4', false, '100.118.147.2/32'),
        entry('fd7a:115c:a1e0::f801:93dc', 'IPv6', false, 'fd7a:115c:a1e0::f801:93dc/48'),
      ],
    };

    it('lets in another device on the tailnet, by IPv4 or IPv6', () => {
      expect(isLocalNetworkPeer('100.101.7.12', withTailnet)).toBe(true);
      expect(isLocalNetworkPeer('::ffff:100.64.0.1', withTailnet)).toBe(true);
      expect(isLocalNetworkPeer('100.127.255.254', withTailnet)).toBe(true);
      expect(isLocalNetworkPeer('fd7a:115c:a1e0::aa', withTailnet)).toBe(true);
    });

    it('still cuts addresses outside the range, and the internet', () => {
      expect(isLocalNetworkPeer('100.128.0.1', withTailnet)).toBe(false);
      expect(isLocalNetworkPeer('100.63.255.255', withTailnet)).toBe(false);
      expect(isLocalNetworkPeer('8.8.8.8', withTailnet)).toBe(false);
    });

    it('opens the range only on a Tailscale interface', () => {
      expect(isLocalNetworkPeer('100.101.7.12', interfaces)).toBe(false);
      // A cellular modem on carrier NAT: a /32 in the range, but no Tailscale IPv6 address.
      const carrierModem = {
        ...interfaces,
        ppp0: [entry('100.70.3.4', 'IPv4', false, '100.70.3.4/32')],
      };
      expect(isLocalNetworkPeer('100.70.3.9', carrierModem)).toBe(false);
      expect(isLocalNetworkPeer('100.101.7.12', carrierModem)).toBe(false);
      const wideCarrier = {
        ...interfaces,
        en1: [entry('100.70.1.5', 'IPv4', false, '100.70.1.5/22')],
      };
      expect(isLocalNetworkPeer('100.70.2.9', wideCarrier)).toBe(true);
      expect(isLocalNetworkPeer('100.101.7.12', wideCarrier)).toBe(false);
      const otherPointToPoint = {
        ...interfaces,
        utun3: [entry('10.9.0.2', 'IPv4', false, '10.9.0.2/32')],
      };
      expect(isLocalNetworkPeer('10.9.0.3', otherPointToPoint)).toBe(false);
    });
  });
});
