import { describe, it, expect } from 'vitest';
import { parseDestination, parseConnectAuthority, classifyAddress } from '../index.js';

describe('canonical authority', () => {
  it('canonicalizes case/root dot/default port/IPv6 and binds Host to that exact authority', () => {
    expect(
      parseDestination({
        url: 'HTTPS://Public.Fixture.Invalid.:443/private?token=fake',
        hostHeader: 'public.fixture.invalid',
      })
    ).toMatchObject({
      scheme: 'https',
      hostname: 'public.fixture.invalid',
      authority: 'public.fixture.invalid:443',
      port: 443,
    });
    expect(
      parseDestination({ url: 'http://[0:0:0:0:0:0:0:1]:8080/', hostHeader: '[::1]:8080' })
    ).toMatchObject({ hostname: '::1', family: 6, port: 8080 });
    expect(
      parseConnectAuthority('Public.Fixture.Invalid:443', 'public.fixture.invalid:443')
    ).toMatchObject({ scheme: 'https', port: 443 });
  });
  it.each([
    'http://user:secret@public.fixture.invalid/',
    'http://public.fixture.invalid\\@127.0.0.1/',
    'http://127.1/',
    'http://127.0.0.1./',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://0177.0.0.1/',
    'http://%31%32%37.0.0.1/',
    'http://[fe80::1%25en0]/',
    'http://public.fixture.invalid:0/',
    'http://public.fixture.invalid:080/',
    'http://public.fixture.invalid:65536/',
    'http://public.fixture.invalid:/',
    'http://public..fixture.invalid/',
    'http:// public.fixture.invalid/',
    'http://public.fixture.invalid\n/',
    'http://公共.invalid/',
    'http://[127.0.0.1]/',
    'http://::1/',
    'file:///tmp/fake',
    'javascript:alert(1)',
    'ftp://public.fixture.invalid/',
    'data:text/plain,fake',
  ])('refuses ambiguous or forbidden spelling %s', (url) => {
    expect(() => parseDestination({ url })).toThrow();
  });
  it.each([
    'other.fixture.invalid',
    'public.fixture.invalid:81',
    'user@public.fixture.invalid',
    'public.fixture.invalid,other.fixture.invalid',
    'public.fixture.invalid:080',
  ])('refuses mismatched or malformed Host %s', (hostHeader) => {
    expect(() => parseDestination({ url: 'http://public.fixture.invalid/', hostHeader })).toThrow();
  });
  it.each([
    'public.fixture.invalid',
    'user@public.fixture.invalid:443',
    'public.fixture.invalid:0',
    'public.fixture.invalid:443/path',
  ])('refuses malformed CONNECT %s', (authority) => {
    expect(() => parseConnectAuthority(authority)).toThrow();
  });
});

describe('IANA-derived numeric destination classification', () => {
  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '192.31.196.1',
    '192.52.193.1',
    '192.175.48.1',
    '2001:4860:4860::8888',
    '2606:4700:4700::1111',
    '2620:4f:8000::1',
  ])('recognizes ordinary global or globally reachable numeric %s', (address) => {
    expect(classifyAddress(address).kind).toBe('global');
  });
  it.each([
    '0.0.0.0',
    '0.5.1.1',
    '10.0.0.1',
    '100.64.0.1',
    '100.127.255.254',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.254',
    '192.0.0.9',
    '192.0.2.1',
    '192.88.99.2',
    '192.168.1.1',
    '198.18.0.1',
    '198.19.255.254',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '239.255.255.255',
    '240.0.0.1',
    '255.255.255.255',
    '168.63.129.16',
    '::',
    '64:ff9b::a00:1',
    '64:ff9b:1::1',
    '100::1',
    '100:0:0:1::1',
    '2001::1',
    '2001:2::1',
    '2001:20::1',
    '2001:db8::1',
    '2002:7f00:1::1',
    '3fff::1',
    '5f00::1',
    'fc00::1',
    'fd00::1',
    'fe80::1',
    'fec0::1',
    'ff02::1',
    '4000::1',
  ])('refuses reserved/private/metadata/transition numeric %s', (address) => {
    expect(classifyAddress(address).kind).toBe('nonglobal');
  });
  it.each(['::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:8.8.8.8', '::ffff:a00:1'])(
    'recognizes and refuses mapped IPv6 %s',
    (address) => {
      expect(classifyAddress(address).kind).toBe('mapped');
    }
  );
  it.each(['127.0.0.1', '127.255.255.254', '::1', '0:0:0:0:0:0:0:1'])(
    'classifies literal loopback separately for exact grants %s',
    (address) => {
      expect(classifyAddress(address).kind).toBe('loopback');
    }
  );
  it.each(['127.1', '0177.0.0.1', 'fe80::1%en0', 'not-an-address'])(
    'refuses nonnumeric/ambiguous address %s',
    (address) => {
      expect(() => classifyAddress(address)).toThrow();
    }
  );
});

it('normalizes native URL parser failures for invalid numeric quads into a fixed refusal', () => {
  let refused: unknown;
  try {
    parseDestination({ url: 'https://999.999.999.999/' });
  } catch (error) {
    refused = error;
  }
  expect(refused).toMatchObject({ code: 'INVALID_DESTINATION' });
  expect(refused).not.toHaveProperty('input');
});
