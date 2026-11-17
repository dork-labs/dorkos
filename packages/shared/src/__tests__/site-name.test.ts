import { describe, expect, it } from 'vitest';
import { siteName } from '../site-name.js';

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
