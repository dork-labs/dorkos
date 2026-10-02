import { BlockList, isIP } from 'node:net';
import { EgressPolicyError } from './errors.js';

const ipv4Denied = new BlockList();
// IANA IPv4 Special-Purpose Registry (2025-10-09), RFC6890/8190 plus multicast RFC1112.
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// Conservatively refuse the whole protocol/retired relay blocks, including their exceptions.
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
  ['168.63.129.16', 32],
] as const)
  ipv4Denied.addSubnet(address, prefix, 'ipv4');
const ipv6Global = new BlockList();
ipv6Global.addSubnet('2000::', 3, 'ipv6');
const ipv6Denied = new BlockList();
// IANA IPv6 Special-Purpose Registry (2025-10-09). Restrict ordinary global unicast;
// https://www.iana.org/assignments/iana-ipv6-special-registry/
// refuse protocol-assignment/transition blocks rather than infer embedded IPv4 reachability.
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  ipv6Denied.addSubnet(address, prefix, 'ipv6');
const mapped = new BlockList();
mapped.addSubnet('::ffff:0:0', 96, 'ipv6');

/** A normalized literal; mapped IPv6 remains explicitly denied even for a global embedded IPv4. */
export interface NumericAddress {
  readonly address: string;
  readonly family: 4 | 6;
  readonly kind: 'global' | 'loopback' | 'mapped' | 'nonglobal';
}

/** Classify numeric endpoints without DNS or normalization of ambiguous IPv4 shorthand. */
export function classifyAddress(value: string): NumericAddress {
  if (typeof value !== 'string') throw new EgressPolicyError('ADDRESS_DENIED');
  const family = isIP(value);
  if (!family || value.includes('%')) throw new EgressPolicyError('ADDRESS_DENIED');
  const address = family === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value;
  let kind: NumericAddress['kind'] = 'nonglobal';
  if (family === 4) {
    if (address.startsWith('127.')) kind = 'loopback';
    else if (!ipv4Denied.check(address, 'ipv4')) kind = 'global';
  } else if (address === '::1') kind = 'loopback';
  else if (mapped.check(address, 'ipv6')) kind = 'mapped';
  else if (ipv6Global.check(address, 'ipv6') && !ipv6Denied.check(address, 'ipv6')) kind = 'global';
  return Object.freeze({ address, family: family as 4 | 6, kind });
}
