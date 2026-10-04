/**
 * The network guard's re-check of RESOLVED addresses (DOR-2686 task 3.2; a
 * Phase 1 review finding): an allowed public name must not reach loopback or
 * the LAN on a port nobody listed just because DNS says so. `*.nip.io`,
 * `localtest.me` and any rebinding domain resolve that way on purpose.
 *
 * Real DNS for such names needs the internet, so each case runs the real
 * guard (bundled from source) in a plain Node process whose `dns.lookup`
 * answers from a fixed table, installed BEFORE the guard captures it. The
 * connection itself is real, to a local server this test owns, and the
 * server's accept count is the evidence.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A plain process: fake DNS, then the guard, then one connection. */
const RUNNER = `
const dns = require('dns');
const real = dns.lookup;
const table = JSON.parse(process.env.FAKE_DNS);
dns.lookup = function (name, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  const answer = table[name];
  if (!answer) return real.call(dns, name, opts, cb);
  const list = answer.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  if (opts && opts.all) return process.nextTick(cb, null, list);
  process.nextTick(cb, null, list[0].address, list[0].family);
};
require(process.env.GUARD).installNetGuard({
  allowNet: JSON.parse(process.env.ALLOW),
  dorkosPort: Number(process.env.DORKOS_PORT),
});
const net = require('net');
const socket = net.connect({ host: process.env.HOST, port: Number(process.env.PORT) });
const done = (result) => { socket.destroy(); process.send(result, () => process.exit(0)); };
socket.once('connect', () => done({ ok: true }));
socket.once('error', (e) => done({ ok: false, code: e.code || null, message: e.message }));
setTimeout(() => done({ ok: false, code: 'timeout' }), 3000);
`;

describe('NetGuard re-checks resolved addresses', () => {
  let tmp: string;
  let guardBundle: string;
  let runner: string;
  let server: net.Server;
  let port: number;
  let accepted: number;
  const sockets = new Set<net.Socket>();

  beforeAll(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-guard-')));
    const { build } = await import('esbuild');
    guardBundle = path.join(tmp, 'guard.cjs');
    await build({
      entryPoints: [path.join(HERE, '..', 'child', 'net-guard.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22.22',
      outfile: guardBundle,
      logLevel: 'silent',
    });
    runner = path.join(tmp, 'runner.cjs');
    await fs.writeFile(runner, RUNNER);
    return async () => {
      await fs.rm(tmp, { recursive: true, force: true });
    };
  });

  beforeEach(async () => {
    accepted = 0;
    server = net.createServer((socket) => {
      accepted++;
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as net.AddressInfo).port;
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  /** Run one connection through the guard with a fake DNS table. */
  function attempt(options: {
    allow: string[];
    dns: Record<string, string[]>;
    host: string;
    port: number;
    dorkosPort?: number;
  }): Promise<{ ok: boolean; code?: string | null; message?: string }> {
    const child = fork(runner, [], {
      execArgv: [],
      env: {
        GUARD: guardBundle,
        ALLOW: JSON.stringify(options.allow),
        FAKE_DNS: JSON.stringify(options.dns),
        HOST: options.host,
        PORT: String(options.port),
        DORKOS_PORT: String(options.dorkosPort ?? 1),
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('runner timed out'));
      }, 10_000);
      child.once('message', (result) => {
        clearTimeout(timer);
        resolve(result as { ok: boolean; code?: string | null });
      });
      child.once('error', reject);
    });
  }

  // Purpose: a wildcard over a public domain matches the name, but the name
  // resolving to loopback on an unlisted port is refused, never connected.
  it('refuses *.nip.io resolving to loopback on an unlisted port', async () => {
    const result = await attempt({
      allow: ['*.nip.io'],
      dns: { 'app.127.0.0.1.nip.io': ['127.0.0.1'] },
      host: 'app.127.0.0.1.nip.io',
      port,
    });
    expect(result).toMatchObject({ ok: false, code: 'ERR_EXTENSION_NET_DENIED' });
    expect(accepted).toBe(0);
  });

  // Purpose: the same answer IS allowed when the address and port are
  // themselves declared — the control that shows the refusal above is the
  // re-check, not a broken connection.
  it('allows it when that address and port are declared too', async () => {
    const result = await attempt({
      allow: ['*.nip.io', `127.0.0.1:${port}`],
      dns: { 'app.127.0.0.1.nip.io': ['127.0.0.1'] },
      host: 'app.127.0.0.1.nip.io',
      port,
    });
    expect(result).toEqual({ ok: true });
    expect(accepted).toBe(1);
  });

  // Purpose: a declared LOCAL name (which the grammar makes carry a port) may
  // resolve to a local address.
  it('lets a declared local name resolve locally', async () => {
    const result = await attempt({
      allow: [`app.localhost:${port}`],
      dns: { 'app.localhost': ['127.0.0.1'] },
      host: 'app.localhost',
      port,
    });
    expect(result).toEqual({ ok: true });
  });

  // Purpose: a private (RFC 1918) answer for a public name is refused too.
  it('refuses a public name resolving into the LAN', async () => {
    const result = await attempt({
      allow: ['localtest.me'],
      dns: { 'localtest.me': ['192.168.1.50'] },
      host: 'localtest.me',
      port,
    });
    expect(result).toMatchObject({ ok: false, code: 'ERR_EXTENSION_NET_DENIED' });
  });

  // Purpose: one local address among several answers spoils them all (Happy
  // Eyeballs would otherwise try it).
  it('refuses mixed answers that include a local address', async () => {
    const result = await attempt({
      allow: ['api.example.com'],
      dns: { 'api.example.com': ['93.184.216.34', '127.0.0.1'] },
      host: 'api.example.com',
      port,
    });
    expect(result).toMatchObject({ ok: false, code: 'ERR_EXTENSION_NET_DENIED' });
    expect(accepted).toBe(0);
  });

  // Purpose: a name resolving to DorkOS's own port on loopback is refused even
  // when that address and port are declared.
  it("refuses a name resolving to DorkOS's own port", async () => {
    const result = await attempt({
      allow: ['api.example.com', `127.0.0.1:${port}`],
      dns: { 'api.example.com': ['127.0.0.1'] },
      host: 'api.example.com',
      port,
      dorkosPort: port,
    });
    expect(result).toMatchObject({ ok: false, code: 'ERR_EXTENSION_NET_DENIED' });
    expect(accepted).toBe(0);
  });
});
