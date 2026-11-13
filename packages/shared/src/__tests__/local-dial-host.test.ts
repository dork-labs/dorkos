import { describe, expect, it } from 'vitest';
import { localDialHost } from '../local-dial-host.js';

describe('localDialHost', () => {
  it('passes localhost through unchanged — same name, same resolved family', () => {
    expect(localDialHost('localhost')).toBe('localhost');
  });

  it('maps the IPv4 wildcard 0.0.0.0 to localhost — 0.0.0.0 is not dialable on Windows', () => {
    expect(localDialHost('0.0.0.0')).toBe('localhost');
  });

  it('maps the IPv6 wildcard :: to localhost', () => {
    expect(localDialHost('::')).toBe('localhost');
    expect(localDialHost('[::]')).toBe('localhost');
  });

  it('brackets IPv6 literals so the minted URL parses', () => {
    expect(localDialHost('::1')).toBe('[::1]');
    expect(localDialHost('fe80::1')).toBe('[fe80::1]');
    // Already-bracketed input is not double-bracketed.
    expect(localDialHost('[::1]')).toBe('[::1]');
    // The result must actually survive URL construction.
    expect(() => new URL(`http://${localDialHost('::1')}:4242`)).not.toThrow();
  });

  it('passes hostnames and IPv4 addresses through unchanged', () => {
    expect(localDialHost('dorkos.internal')).toBe('dorkos.internal');
    expect(localDialHost('127.0.0.1')).toBe('127.0.0.1');
  });
});
