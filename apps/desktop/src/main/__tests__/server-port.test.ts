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
  it('asks for 4242, the port every doc and MCP snippet names, and calls it a default', async () => {
    process.env.DORK_HOME = dataDirectory();
    const { resolvePreferredPort, PREFERRED_SERVER_PORT } = await import('../server-port');

    expect(resolvePreferredPort()).toEqual({ port: PREFERRED_SERVER_PORT, source: 'default' });
    // The desktop half of a coupling `packages/shared`'s config-schema test
    // holds the other half of, with the full explanation: this number has to
    // equal `UserConfigSchema`'s `server.port` default, or the check below
    // ("not a choice somebody made") stops recognising the value `conf` writes.
    expect(PREFERRED_SERVER_PORT).toBe(4242);
  });

  it('honours the same server.port the CLI reads, so a pin means one thing', async () => {
    process.env.DORK_HOME = dataDirectory({ server: { port: 4500 } });
    const { resolvePreferredPort } = await import('../server-port');

    expect(resolvePreferredPort()).toEqual({ port: 4500, source: 'config.json' });
  });

  it('does not read the default `conf` writes to disk as a choice somebody made', async () => {
    // `conf` materializes defaults: `config-manager.ts` hands it both `defaults`
    // and `migrations`, and its migration pass writes the whole defaulted tree
    // back whenever the file differs from it. So this block is on essentially
    // every machine that has booted DorkOS once, written by the library and
    // typed by nobody. Reading it as a pin made the step-up branch dead for
    // everyone and told people DorkOS was "set to use port 4242" — a setting
    // they never made.
    process.env.DORK_HOME = dataDirectory({
      version: 1,
      server: { port: 4242, cwd: null, boundary: null, open: true },
    });
    const { resolvePreferredPort, PREFERRED_SERVER_PORT } = await import('../server-port');

    expect(resolvePreferredPort()).toEqual({ port: PREFERRED_SERVER_PORT, source: 'default' });
  });

  it('lets DORKOS_PORT win over the pinned one, matching the CLI precedence', async () => {
    process.env.DORK_HOME = dataDirectory({ server: { port: 4500 } });
    process.env.DORKOS_PORT = '4600';
    const { resolvePreferredPort } = await import('../server-port');

    expect(resolvePreferredPort()).toEqual({ port: 4600, source: 'DORKOS_PORT' });
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
      expect(resolvePreferredPort()).toEqual({ port: PREFERRED_SERVER_PORT, source: 'default' });
    }
  });

  it('ignores a hand-edited privileged port in config, and says why', async () => {
    // `UserConfigSchema` enforces a 1024 floor, so a value below it could never
    // have been written through the config manager — it is malformed input, not
    // a choice. Honouring it would refuse the launch with EACCES on a port the
    // person could not have set through any supported route.
    const log = await getLogMock();
    process.env.DORK_HOME = dataDirectory({ server: { port: 80 } });
    const { resolvePreferredPort, PREFERRED_SERVER_PORT } = await import('../server-port');

    expect(resolvePreferredPort()).toEqual({ port: PREFERRED_SERVER_PORT, source: 'default' });
    expect(log.default.warn.mock.calls.flat().join(' ')).toMatch(/server\.port 80/);
  });

  it('ignores a DORKOS_PORT that is not a port', async () => {
    process.env.DORK_HOME = dataDirectory();
    process.env.DORKOS_PORT = 'not-a-number';
    const { resolvePreferredPort, PREFERRED_SERVER_PORT } = await import('../server-port');

    expect(resolvePreferredPort()).toEqual({ port: PREFERRED_SERVER_PORT, source: 'default' });
  });

  it('keeps a privileged DORKOS_PORT, because exporting one is deliberate', async () => {
    // `apps/server/src/env.ts` accepts the whole 1–65535 range here, and the
    // refusal for one DorkOS cannot bind says so accurately rather than
    // pretending the setting was never made.
    process.env.DORK_HOME = dataDirectory();
    process.env.DORKOS_PORT = '80';
    const { resolvePreferredPort } = await import('../server-port');

    expect(resolvePreferredPort()).toEqual({ port: 80, source: 'DORKOS_PORT' });
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
  it('uses a pinned port that is free, and says nothing about it', async () => {
    const log = await getLogMock();
    const block = await reserveBlock(1);
    const free = block.base;
    await block.release();
    process.env.DORK_HOME = dataDirectory({ server: { port: free } });
    const { chooseServerPort } = await import('../server-port');

    expect(await chooseServerPort()).toBe(free);
    expect(log.default.info).not.toHaveBeenCalled();
  });

  it('steps up rather than refusing when config.json only holds the written-out default', async () => {
    // The regression this file exists to keep out. With `conf`'s defaults on
    // disk and 4242 held by a `dorkos` in a terminal, opening the app refused,
    // blamed a setting nobody had made, and sent the person to
    // `dorkos config set server.port` — which lands them on the data-directory
    // lock instead. Scanning is the only correct answer here.
    process.env.DORK_HOME = dataDirectory({
      version: 1,
      server: { port: 4242, cwd: null, boundary: null, open: true },
    });
    const { chooseServerPort, PREFERRED_SERVER_PORT } = await import('../server-port');
    const holder = await bind(PREFERRED_SERVER_PORT);

    try {
      expect(await chooseServerPort()).toBeGreaterThan(PREFERRED_SERVER_PORT);
    } finally {
      if (holder) await close([holder]);
    }
  });

  it('moves off a busy default and records it in the log, interrupting nobody', async () => {
    const log = await getLogMock();
    process.env.DORK_HOME = dataDirectory(); // no pin, so the default applies
    const { chooseServerPort, PREFERRED_SERVER_PORT } = await import('../server-port');
    // `null` here means something real already holds 4242, which is the same
    // precondition this test needs.
    const holder = await bind(PREFERRED_SERVER_PORT);

    try {
      const port = await chooseServerPort();

      expect(port).toBeGreaterThan(PREFERRED_SERVER_PORT);
      const logged = log.default.info.mock.calls.flat().join(' ');
      expect(logged).toContain(String(PREFERRED_SERVER_PORT));
      expect(logged).toContain(String(port));
      // A default that moves is a small, self-correcting accommodation. The
      // only start-up conflict worth interrupting someone for is the data
      // directory's (ADR 260726-234122), which the server itself reports.
      expect(log.default.warn).not.toHaveBeenCalled();
      expect(log.default.error).not.toHaveBeenCalled();
    } finally {
      if (holder) await close([holder]);
    }
  });

  it('refuses a taken pin rather than moving off an address other tools are set to', async () => {
    // The scenario that decides this: someone pins 5000 *because* their MCP
    // config says 5000. Coming up on 5001 instead would break every client they
    // configured, with nothing anywhere reporting a fault. A default is a
    // guess and may move; a pin is a commitment and may not.
    const block = await reserveBlock(2);
    process.env.DORK_HOME = dataDirectory({ server: { port: block.base } });
    const { chooseServerPort } = await import('../server-port');

    try {
      // The next port up is deliberately free: an implementation that scanned
      // would find it and succeed, so this cannot pass by accident.
      await block.releaseAt(1);

      const err = await chooseServerPort().then(
        () => null,
        (e: unknown) => e as Error
      );
      expect(err).not.toBeNull();
      expect(err!.message).toContain(String(block.base));
      expect(err!.message).toMatch(/already has it/i);
      expect(err!.message).toMatch(/will not quietly move/i);
      // The way out, worded for a pin that lives in config.json.
      expect(err!.message).toMatch(/dorkos config set server\.port/);
      expect(err!.message).toContain('config.json');
    } finally {
      await block.release();
    }
  });

  it('points at the environment variable when that is where the pin came from', async () => {
    const block = await reserveBlock(1);
    process.env.DORK_HOME = dataDirectory();
    process.env.DORKOS_PORT = String(block.base);
    const { chooseServerPort } = await import('../server-port');

    try {
      const err = await chooseServerPort().then(
        () => null,
        (e: unknown) => e as Error
      );
      expect(err).not.toBeNull();
      // Telling someone to edit config.json would be wrong here: DORKOS_PORT
      // wins over it, so the edit would appear to do nothing.
      expect(err!.message).toContain('DORKOS_PORT');
      expect(err!.message).not.toContain('config.json');
    } finally {
      await block.release();
    }
  });

  it('says a forbidden pin is forbidden, not that something is using it', async () => {
    // Folding EACCES into "taken" is right for the scan and wrong for the
    // message: "quit whatever is using it" is unfollowable advice when nothing
    // is using it and the operating system simply will not hand it over.
    process.env.DORK_HOME = dataDirectory();
    process.env.DORKOS_PORT = '80';
    const { chooseServerPort } = await import('../server-port');

    const outcome = await chooseServerPort().then(
      (port) => ({ port, err: null }),
      (e: unknown) => ({ port: null, err: e as Error })
    );
    if (outcome.port !== null) {
      // This process may bind port 80 (running as root, or a container with
      // CAP_NET_BIND_SERVICE). There is no EACCES to observe, so there is
      // nothing here to assert — the busy-pin case above covers the wording
      // this test exists to keep apart from it.
      return;
    }
    expect(outcome.err!.message).toMatch(/will not let it listen/i);
    expect(outcome.err!.message).toMatch(/administrator rights/i);
    expect(outcome.err!.message).not.toMatch(/already has it/i);
    expect(outcome.err!.message).not.toMatch(/quit whatever/i);
  });
});
