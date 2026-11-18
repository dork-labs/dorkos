import { describe, expect, it } from 'vitest';
import { keptHostTail, siteName } from '../site-name.js';

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
  ])('shows %s as %s', (host, name) => {
    expect(siteName(host)).toBe(name);
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
  ])('keeps the end of %s as %s', (host, tail) => {
    expect(keptHostTail(host)).toBe(tail);
    expect(host.endsWith(tail)).toBe(true);
  });
});
