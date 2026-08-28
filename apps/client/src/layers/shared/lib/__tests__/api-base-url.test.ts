import { describe, it, expect, afterEach, vi } from 'vitest';

import { resolveApiBaseUrl } from '../api-base-url';

/**
 * Pretend to be the desktop shell, answering with `port`.
 *
 * Cast at the seam because a real {@link ElectronAPI} is a dozen IPC methods
 * this question does not involve — and because half these cases are answers the
 * TYPE forbids, which is the point: the bridge is `sendSync` across a process
 * boundary, so what arrives is whatever the main process put on the wire.
 */
function shellReporting(port: unknown): void {
  window.electronAPI = { getServerPort: () => port } as unknown as ElectronAPI;
}

afterEach(() => {
  delete (window as { electronAPI?: unknown }).electronAPI;
  vi.restoreAllMocks();
});

describe('where the cockpit sends its requests', () => {
  it('uses the relative path in a browser, where the server answers the same origin', () => {
    expect(resolveApiBaseUrl()).toBe('/api');
  });

  it('pins the desktop shell to the port its server is really on', () => {
    shellReporting(4242);

    expect(resolveApiBaseUrl()).toBe('http://localhost:4242/api');
  });

  /**
   * Answers the bridge can genuinely give, and what each one used to produce.
   *
   * `null` is the honest one: `getServerPort()` in the main process holds `null`
   * whenever the server is not up — during startup, after a crash, between
   * restarts — and this resolver runs at boot. It produced
   * `http://localhost:null/api`, an origin every request and every durable
   * stream then failed against with nothing saying why.
   */
  const NOT_A_PORT: [name: string, value: unknown][] = [
    ['no server yet', null],
    ['nothing at all', undefined],
    ['a port that is not a number', 'sixty-two forty-two'],
    ['a failed parse', Number.NaN],
    ['zero', 0],
    ['a negative port', -1],
    ['a fractional port', 4242.5],
    ['a port past the top of the range', 65_536],
  ];

  it.each(NOT_A_PORT)('falls back to the relative path: %s', (_name, value) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    shellReporting(value);

    expect(resolveApiBaseUrl()).toBe('/api');
    // Loud, because the fallback is silent otherwise. It is usually harmless —
    // the packaged shell is served by the very server it asks, so `/api` lands
    // in the same place — but on the shell's `file://` last resort it reaches
    // nothing, and either way the port not arriving is worth a line.
    expect(logged).toHaveBeenCalled();
  });

  it('keeps the top of the port range', () => {
    shellReporting(65_535);

    expect(resolveApiBaseUrl()).toBe('http://localhost:65535/api');
  });
});
