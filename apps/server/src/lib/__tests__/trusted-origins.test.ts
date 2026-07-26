import { describe, it, expect, vi } from 'vitest';

vi.mock('../../env.js', () => ({ env: { DORKOS_PORT: 4242 } }));
vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: { status: { url: null } },
}));

import { isLoopbackHost, isLoopbackHostHeader, parseHostname } from '../trusted-origins.js';

describe('parseHostname', () => {
  it.each([
    ['localhost:4242', 'localhost'],
    ['localhost', 'localhost'],
    ['EXAMPLE.com:8443', 'example.com'],
    ['[::1]:4242', '::1'],
    ['[::1]', '::1'],
    ['  localhost:4242  ', 'localhost'],
  ])('parses %s to %s', (header, expected) => {
    expect(parseHostname(header)).toBe(expected);
  });

  it.each([undefined, '', '   ', ':4242', '[]'])('returns null for %s', (header) => {
    expect(parseHostname(header)).toBeNull();
  });
});

describe('isLoopbackHost', () => {
  it.each(['localhost', '127.0.0.1', '::1', 'LOCALHOST', '  localhost  '])('accepts %s', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(['0.0.0.0', 'evil.com', 'localhost.evil.com', '127.0.0.1.evil.com', '::2'])(
    'rejects %s',
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    }
  );
});

describe('isLoopbackHostHeader', () => {
  it.each(['localhost', 'localhost:4242', '127.0.0.1:9999', '[::1]:4242'])(
    'accepts the Host header %s regardless of port',
    (header) => {
      expect(isLoopbackHostHeader(header)).toBe(true);
    }
  );

  it.each([undefined, '', 'evil.com', 'evil.com:4242', 'localhost.evil.com'])(
    'rejects the Host header %s',
    (header) => {
      expect(isLoopbackHostHeader(header)).toBe(false);
    }
  );

  // DOR-532 review. The predicate takes the RAW header precisely so no
  // `X-Forwarded-*` value can reach it. `req.hostname` would have said
  // "localhost" for this request; passing the real Host keeps it honest.
  it('judges the real Host, so a spoofed X-Forwarded-Host cannot reach it', () => {
    expect(isLoopbackHostHeader('dorkos.example.com')).toBe(false);
  });
});
