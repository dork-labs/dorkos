import { describe, it, expect } from 'vitest';
import net from 'net';
import { formatPidfile, isPortInUse, parsePidfile } from '../supervisor.js';

/**
 * Unit tests for the capture supervisor's pure/deterministic logic: pidfile
 * serialization (round-trips and corruption tolerance) and TCP port probing.
 * The signal/kill and reconciliation paths touch live OS process groups and are
 * exercised by the capture harness itself, not here.
 *
 * @module capture/__tests__/supervisor
 */
describe('parsePidfile', () => {
  it('round-trips a list of pids through formatPidfile', () => {
    expect(parsePidfile(formatPidfile([123, 456]))).toEqual([123, 456]);
  });

  it('returns an empty string (and parses to []) for no pids', () => {
    expect(formatPidfile([])).toBe('');
    expect(parsePidfile('')).toEqual([]);
  });

  it('tolerates blank lines and stray whitespace', () => {
    expect(parsePidfile('\n  123 \n\n456\n  \n')).toEqual([123, 456]);
  });

  it('drops junk, non-integers, and non-positive values', () => {
    // A corrupt pidfile must degrade to "nothing to reconcile", never throw.
    expect(parsePidfile('123\nnope\n-4\n0\n7.5\n89')).toEqual([123, 89]);
  });
});

describe('isPortInUse', () => {
  it('reports true while a server is listening and false after it closes', async () => {
    const server = net.createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });

    expect(await isPortInUse(port)).toBe(true);

    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(await isPortInUse(port)).toBe(false);
  });
});
