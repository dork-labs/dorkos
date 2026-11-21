import { describe, expect, it } from 'vitest';
import { keptHostTail, schemefulSiteKey, siteName } from '../site-name.js';

describe('siteName', () => {
  it.each([
    ['accounts.google.com', 'google.com'],
    ['sso.godaddy.com', 'godaddy.com'],
    ['www.northwind.example', 'northwind.example'],
    ['shop.example:8443', 'shop.example'],
    ['login.shop.co.uk', 'shop.co.uk'],
    ['my.bank.com.au', 'bank.com.au'],
    ['google.com', 'google.com'],
    ['localhost:6000', 'localhost'],
    ['192.168.1.20:8080', '192.168.1.20'],
    ['[::1]:3000', '[::1]'],
    ['ACCOUNTS.Google.COM', 'google.com'],
    ['login.alice.github.io', 'alice.github.io'],
    ['login.bob.github.io', 'bob.github.io'],
    // DOR-4650: these suffixes were absent from the handwritten display list.
    ['login.shop.com.pl', 'shop.com.pl'],
    ['login.shop.k12.ak.us', 'shop.k12.ak.us'],
  ])('shows %s as %s', (host, name) => {
    expect(siteName(host)).toBe(name);
  });
});

describe('schemefulSiteKey', () => {
  it.each([
    ['https://accounts.google.com/a', 'https://google.com'],
    ['https://GOOGLE.com:8443/b', 'https://google.com'],
    ['http://accounts.google.com', 'http://google.com'],
    ['https://login.alice.github.io', 'https://alice.github.io'],
    ['https://login.bob.github.io', 'https://bob.github.io'],
    ['https://login.shop.k12.ak.us', 'https://shop.k12.ak.us'],
    ['http://127.1:8080', 'http://127.0.0.1:8080'],
    ['http://[::1]:8080', 'http://[::1]:8080'],
  ])('keys the normalized URL %s as %s', (url, key) => {
    expect(schemefulSiteKey(url)).toBe(key);
  });

  it.each([
    ['https://a.github.io', 'https://b.github.io'],
    ['https://a.vercel.app', 'https://b.vercel.app'],
    ['https://alice.github.io', 'https://bob.github.io'],
    ['http://192.0.2.1:8080', 'http://192.0.2.2:8080'],
    ['https://google.com', 'http://google.com'],
    ['https://google.com', 'https://google.com.attacker.com'],
    ['https://google.com', 'https://notgoogle.com'],
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8081'],
  ])('separates owners or schemes at %s and %s', (first, second) => {
    expect(schemefulSiteKey(first)).not.toBe(schemefulSiteKey(second));
  });

  it.each([
    '',
    'http://localhost:6000',
    'http://sub.localhost:6000',
    'https://bücher.de/',
    'https://xn--bcher-kva.de/',
    'https://xn--.com/',
    'https://example.com./',
    'https://github.io',
    'https://com',
    'https://intranet',
    'https://login.shop.example',
    'https://login.shop.thissuffixdoesnotexist',
    'about:blank',
    'file:///tmp/page.html',
    'data:text/html,hello',
    'blob:https://example.com/id',
    'javascript:void(0)',
    'not a URL',
  ])('grants no key for %s', (url) => {
    expect(schemefulSiteKey(url)).toBeNull();
  });

  it('never turns a display-only last-label fallback into authority', () => {
    const host = 'login.shop.thissuffixdoesnotexist';
    expect(siteName(host)).toBe('shop.thissuffixdoesnotexist');
    expect(schemefulSiteKey(`https://${host}`)).toBeNull();
    expect(schemefulSiteKey(`https://${siteName(host)}`)).toBeNull();
  });
});

// DOR-4655: the end of a host the address bar never elides.
describe('keptHostTail', () => {
  it.each([
    // A long trusted-looking start never hides the site at the end.
    ['accounts.google.com.attacker.example', 'com.attacker.example'],
    ['a.b.c.d.e.accounts.google.com.attacker.example', 'com.attacker.example'],
    // Three labels or fewer stay whole, the attacker's own label included.
    ['login-google.vercel.app', 'login-google.vercel.app'],
    ['evil.github.io', 'evil.github.io'],
    // A two-part ending keeps the label in front of it, and that is three labels.
    ['victim.attacker.co.za', 'attacker.co.za'],
    ['x.login.shop.co.uk', 'shop.co.uk'],
    // Never cut inside an address or a one-label name.
    ['192.0.2.10', '192.0.2.10'],
    ['192.0.2.10:8080', '192.0.2.10:8080'],
    ['[2001:db8::1]', '[2001:db8::1]'],
    ['[2001:db8::1]:8443', '[2001:db8::1]:8443'],
    ['localhost', 'localhost'],
    ['localhost:5173', 'localhost:5173'],
    ['intranet', 'intranet'],
    // Punycode is just labels: its registrable part stays whole.
    ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
    ['shop.store.xn--bcher-kva.example', 'store.xn--bcher-kva.example'],
    // The port stays on the end.
    ['a.b.shop.example:8443', 'b.shop.example:8443'],
    // The PSL may grow the protected tail; it must never lose the owner label.
    ['a.b.shop.k12.ak.us:8443', 'shop.k12.ak.us:8443'],
    ['a.b.alice.github.io', 'alice.github.io'],
  ])('keeps the end of %s as %s', (host, tail) => {
    expect(keptHostTail(host)).toBe(tail);
    expect(host.endsWith(tail)).toBe(true);
  });
});
