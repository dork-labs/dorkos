import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('electron-log', () => import('./electron-log-mock'));

/**
 * `vi.mock(..., factory)` memoizes its result for the whole test file, so mock
 * state is fetched through the real specifier rather than by importing the mock
 * module directly — `vi.resetModules()` re-evaluates the module under test but
 * never re-invokes a mock factory.
 */
async function getLogMock() {
  const electronLog = await import('electron-log');
  return electronLog as unknown as typeof import('./electron-log-mock');
}

/**
 * Where a real port probe starts looking for a block it can hold.
 *
 * Well clear of DorkOS's own range and of the ephemeral range macOS and Linux
 * hand out, so a test holding ports does not collide with an unrelated one.
 */
const BLOCK_SEARCH_BASE = 41_000;

/** How far to walk looking for a free block before giving up. */
const BLOCK_SEARCH_LIMIT = 200;

/** Ports the probe binds through, matching `PROBE_HOST` in the module under test. */
const HOST = 'localhost';

/** A run of consecutive ports this test holds open. */
interface ReservedBlock {
  /** Lowest port in the run. Every port from here to `base + size - 1` is taken. */
  base: number;
  /** Give one port in the run back, leaving the rest held. */
  releaseAt: (offset: number) => Promise<void>;
  /** Release everything still held. */
  release: () => Promise<void>;
}

/** Bind one port, or resolve `null` when something already has it. */
function bind(port: number): Promise<net.Server | null> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      server.close(() => (err.code === 'EADDRINUSE' ? resolve(null) : reject(err)));
    });
    server.listen(port, HOST, () => resolve(server));
  });
}

function close(servers: net.Server[]): Promise<void> {
  return Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  ).then(() => undefined);
}

/**
 * Hold `size` consecutive ports for the duration of a test.
 *
 * Real sockets rather than a stubbed probe: the point of these tests is that
 * the scan agrees with the operating system about what "taken" means, and a
 * stub can only ever agree with itself. The block is searched for rather than
 * assumed, so a machine that happens to be using one of these ports moves the
 * test along instead of failing it.
 *
 * @param size - How many consecutive ports to hold.
 */
async function reserveBlock(size: number): Promise<ReservedBlock> {
  for (let base = BLOCK_SEARCH_BASE; base < BLOCK_SEARCH_BASE + BLOCK_SEARCH_LIMIT; base += size) {
    const held: net.Server[] = [];
    for (let offset = 0; offset < size; offset++) {
      const server = await bind(base + offset);
      if (!server) break;
      held.push(server);
    }
    if (held.length === size) {
      return {
        base,
        releaseAt: async (offset: number) => {
          const [released] = held.splice(offset, 1);
          if (released) await close([released]);
        },
        release: () => close(held.splice(0)),
      };
    }
    await close(held);
  }
  throw new Error(`could not find ${size} consecutive free ports to reserve`);
}

/** A throwaway data directory, pointed at through `DORK_HOME`. */
function makeDataDirectory(config?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-server-port-'));
  if (config !== undefined) {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  }
  return dir;
}

const originalEnv = { ...process.env };
let temporaryDirectories: string[] = [];

beforeEach(async () => {
  vi.resetModules();
  temporaryDirectories = [];
  delete process.env.DORKOS_PORT;
  delete process.env.DORK_HOME;
  (await getLogMock()).resetLogMock();
});

afterEach(() => {
  process.env = { ...originalEnv };
  for (const dir of temporaryDirectories) fs.rmSync(dir, { recursive: true, force: true });
});

/** Create a data directory that is cleaned up after the test. */
function dataDirectory(config?: unknown): string {
  const dir = makeDataDirectory(config);
  temporaryDirectories.push(dir);
  return dir;
}

describe('resolvePreferredPort', () => {
  it('asks for 4242, the port every doc and MCP snippet names', async () => {
    process.env.DORK_HOME = dataDirectory();
    const { resolvePreferredPort, PREFERRED_SERVER_PORT } = await import('../server-port');

    expect(resolvePreferredPort()).toBe(PREFERRED_SERVER_PORT);
    expect(PREFERRED_SERVER_PORT).toBe(4242);
  });

  it('honours the same server.port the CLI reads, so a pin means one thing', async () => {
    process.env.DORK_HOME = dataDirectory({ server: { port: 4500 } });
    const { resolvePreferredPort } = await import('../server-port');

    expect(resolvePreferredPort()).toBe(4500);
  });

  it('lets DORKOS_PORT win over the pinned one, matching the CLI precedence', async () => {
    process.env.DORK_HOME = dataDirectory({ server: { port: 4500 } });
    process.env.DORKOS_PORT = '4600';
    const { resolvePreferredPort } = await import('../server-port');

    expect(resolvePreferredPort()).toBe(4600);
  });

  it('falls back to the default rather than refusing to start on unusable config', async () => {
    // A hand-mangled file, a port outside the bindable range, and a config that
    // is not an object at all: none of these is a reason to refuse to launch.
    const cases = ['{ not json', JSON.stringify({ server: { port: 0 } }), JSON.stringify(7)];
    for (const raw of cases) {
      const dir = dataDirectory();
      fs.writeFileSync(path.join(dir, 'config.json'), raw);
      process.env.DORK_HOME = dir;
      vi.resetModules();
      const { resolvePreferredPort, PREFERRED_SERVER_PORT } = await import('../server-port');
      expect(resolvePreferredPort()).toBe(PREFERRED_SERVER_PORT);
    }
  });

  it('ignores a DORKOS_PORT that is not a port', async () => {
    process.env.DORK_HOME = dataDirectory();
    process.env.DORKOS_PORT = 'not-a-number';
    const { resolvePreferredPort, PREFERRED_SERVER_PORT } = await import('../server-port');

    expect(resolvePreferredPort()).toBe(PREFERRED_SERVER_PORT);
  });
});

describe('findAvailablePort', () => {
  it('takes the preferred port when it is free', async () => {
    const { findAvailablePort, PORT_SCAN_ATTEMPTS } = await import('../server-port');
    // Held only long enough to prove nothing else has it, then given straight
    // back — the scan should want exactly this port.
    const block = await reserveBlock(1);
    const free = block.base;
    await block.release();

    expect(await findAvailablePort(free, PORT_SCAN_ATTEMPTS)).toBe(free);
  });

  it('steps up one port at a time, deterministically, past whatever is taken', async () => {
    const { findAvailablePort, PORT_SCAN_ATTEMPTS } = await import('../server-port');
    // Hold four in a row and give the last one back, so the only free port in
    // the run is known: the scan must land on base + 3, not on whatever the
    // operating system feels like handing out.
    const block = await reserveBlock(4);
    try {
      await block.releaseAt(3);

      expect(await findAvailablePort(block.base, PORT_SCAN_ATTEMPTS)).toBe(block.base + 3);
      // Stable across calls: the same conditions give the same address, which
      // is the whole point of not asking the OS for one.
      expect(await findAvailablePort(block.base, PORT_SCAN_ATTEMPTS)).toBe(block.base + 3);
    } finally {
      await block.release();
    }
  });

  it('refuses, naming the range and the way out, when the whole range is taken', async () => {
    const { findAvailablePort } = await import('../server-port');
    const attempts = 3;
    const block = await reserveBlock(attempts);
    try {
      await expect(findAvailablePort(block.base, attempts)).rejects.toThrow(
        new RegExp(`${block.base} to ${block.base + attempts - 1}`)
      );
      // A person who hits this cannot fix it from inside the app, so the
      // message has to carry the fix.
      await expect(findAvailablePort(block.base, attempts)).rejects.toThrow(/server.*port/i);
      await expect(findAvailablePort(block.base, attempts)).rejects.toThrow(/config\.json/);
    } finally {
      await block.release();
    }
  });

  it('never scans past the last real port', async () => {
    const { findAvailablePort } = await import('../server-port');
    // 65535 is the ceiling. With it taken, a ten-wide window has nowhere left
    // to go, and must say so rather than probe a port number that cannot exist.
    // (A `null` here means something else already holds it, which is the same
    // condition.)
    const held = await bind(65_535);
    try {
      await expect(findAvailablePort(65_535, 10)).rejects.toThrow(/65535 to 65535/);
    } finally {
      if (held) await close([held]);
    }
  });
});

describe('chooseServerPort', () => {
  it('records the move in the log — and nowhere a person is interrupted by', async () => {
    const log = await getLogMock();
    const block = await reserveBlock(2);
    process.env.DORK_HOME = dataDirectory({ server: { port: block.base } });
    const { chooseServerPort } = await import('../server-port');

    try {
      await block.releaseAt(1);

      expect(await chooseServerPort()).toBe(block.base + 1);
      const logged = log.default.info.mock.calls.flat().join(' ');
      expect(logged).toContain(String(block.base));
      expect(logged).toContain(String(block.base + 1));
      // The only start-up conflict worth a dialog is the data directory's,
      // which the server itself reports (ADR 260726-234122). This one is
      // diagnostics, so it must not raise anything a person has to dismiss.
      expect(log.default.warn).not.toHaveBeenCalled();
      expect(log.default.error).not.toHaveBeenCalled();
    } finally {
      await block.release();
    }
  });

  it('says nothing when it got the port it asked for', async () => {
    const log = await getLogMock();
    const block = await reserveBlock(1);
    const free = block.base;
    await block.release();
    process.env.DORK_HOME = dataDirectory({ server: { port: free } });
    const { chooseServerPort } = await import('../server-port');

    expect(await chooseServerPort()).toBe(free);
    expect(log.default.info).not.toHaveBeenCalled();
  });
});
