/**
 * NetGuard inside a real isolated child (DOR-2686 task 3.2). Each probe is
 * asserted twice: refused in the child, and succeeding in an unrestricted
 * control process (or in the child against a declared host), so no refusal
 * here can pass because the probe was broken.
 *
 * Every destination is a local server this test owns, so nothing reaches the
 * internet, and "undeclared" means a real port that would have answered.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {
  cleanup,
  countingServer,
  createHarness,
  makeHost,
  probe,
  runControl,
  startOk,
  type CountingServer,
  type Harness,
} from './isolation-harness.js';

const DENIED = 'ERR_EXTENSION_NET_DENIED';

describe('NetGuard (real isolated child)', () => {
  let h: Harness;
  let declared: CountingServer;
  let undeclared: CountingServer;

  beforeEach(async () => {
    h = await createHarness();
    declared = await countingServer(h);
    undeclared = await countingServer(h);
  });

  afterEach(async () => {
    await cleanup(h);
  });

  /** A child allowed exactly the declared server. */
  async function child(extra: string[] = [], dorkosPort?: number) {
    const host = makeHost(h, { net: [`127.0.0.1:${declared.port}`, ...extra], dorkosPort });
    await startOk(host);
    return host;
  }

  // Purpose: fetch reaches a declared host and port, and is refused for an
  // undeclared port that is really listening (the control reaches it).
  it('lets fetch reach only declared hosts', async () => {
    const host = await child();
    expect(await probe(host, 'fetch', `http://127.0.0.1:${declared.port}/`)).toEqual({
      ok: true,
      value: 200,
    });
    const refused = await probe(host, 'fetch', `http://127.0.0.1:${undeclared.port}/`);
    expect(refused).toMatchObject({ ok: false, code: DENIED });
    expect(refused.cause).toBe(
      `127.0.0.1:${undeclared.port} isn't in this extension's allow.net list.`
    );
    expect(undeclared.count()).toBe(0);
    expect(await runControl(h, 'fetch', `http://127.0.0.1:${undeclared.port}/`)).toEqual({
      ok: true,
      value: 200,
    });
    expect(undeclared.count()).toBe(1);
  });

  // Purpose: TLS and HTTP/2 go through the same guard: refused when
  // undeclared, and they reach the server when declared.
  it('guards tls.connect and http2.connect', async () => {
    const host = await child();
    expect(await probe(host, 'tlsConnect', '127.0.0.1', undeclared.port)).toMatchObject({
      ok: false,
      code: DENIED,
    });
    expect(await probe(host, 'http2Connect', `http://127.0.0.1:${undeclared.port}`)).toMatchObject({
      ok: false,
      code: DENIED,
    });
    expect(undeclared.count()).toBe(0);
    const before = declared.count();
    expect((await probe(host, 'tlsConnect', '127.0.0.1', declared.port)).ok).toBe(true);
    expect(declared.count()).toBe(before + 1);
    expect((await runControl(h, 'tlsConnect', '127.0.0.1', undeclared.port)).ok).toBe(true);
    expect(undeclared.count()).toBe(1);
  });

  // Purpose: DNS questions for names outside the list are refused before any
  // query goes out; a declared local name resolves. The control resolves the
  // same name, so the refusal is the guard's.
  it('answers DNS only for declared names', async () => {
    const host = await child([`localhost:${declared.port}`]);
    expect(await probe(host, 'dnsLookup', 'example.com')).toMatchObject({
      ok: false,
      code: DENIED,
    });
    expect(await probe(host, 'dnsPromisesLookup', 'example.com')).toMatchObject({
      ok: false,
      code: DENIED,
    });
    expect(await probe(host, 'dnsPromisesResolve4', 'example.com')).toMatchObject({
      ok: false,
      code: DENIED,
    });
    expect(await probe(host, 'dnsReverse', '127.0.0.1')).toMatchObject({ ok: false, code: DENIED });
    expect(await probe(host, 'dnsSetServers')).toMatchObject({ ok: false, code: DENIED });
    expect(await probe(host, 'dnsLookup', 'localhost')).toMatchObject({ ok: true });
    const undeclaredHost = makeHost(h, { net: [`127.0.0.1:${declared.port}`] });
    await startOk(undeclaredHost);
    expect(await probe(undeclaredHost, 'dnsLookup', 'localhost')).toMatchObject({
      ok: false,
      code: DENIED,
    });
    expect(await runControl(h, 'dnsLookup', 'localhost')).toMatchObject({ ok: true });
  });

  // Purpose: no UDP and no inbound connections at all; the control can do both.
  it('refuses UDP and listening', async () => {
    const host = await child();
    expect(await probe(host, 'udp')).toMatchObject({
      ok: false,
      code: DENIED,
      message: "Isolated extensions can't use UDP.",
    });
    expect(await probe(host, 'listen')).toMatchObject({
      ok: false,
      code: DENIED,
      message: "Isolated extensions can't accept connections.",
    });
    expect(await runControl(h, 'udp')).toEqual({ ok: true, value: 'created' });
    expect(await runControl(h, 'listen')).toEqual({ ok: true, value: 'listening' });
  });

  // Purpose: DorkOS's own port is refused on loopback even when the manifest
  // declares it, by address and by name.
  it("refuses DorkOS's own port even when declared", async () => {
    const dorkos = await countingServer(h);
    const host = await child(
      [`127.0.0.1:${dorkos.port}`, `localhost:${dorkos.port}`, `[::1]:${dorkos.port}`],
      dorkos.port
    );
    expect(await probe(host, 'tcpConnect', '127.0.0.1', dorkos.port)).toMatchObject({
      ok: false,
      code: DENIED,
    });
    expect(await probe(host, 'tcpConnect', 'localhost', dorkos.port)).toMatchObject({
      ok: false,
      code: DENIED,
    });
    expect(dorkos.count()).toBe(0);
    // The same declaration on a host that is not DorkOS works.
    const other = makeHost(h, { net: [`127.0.0.1:${dorkos.port}`], dorkosPort: 1 });
    await startOk(other);
    expect(await probe(other, 'tcpConnect', '127.0.0.1', dorkos.port)).toEqual({
      ok: true,
      value: 'connected',
    });
  });

  // Purpose: a caller-supplied lookup cannot point an allowed name at an
  // undeclared address: the guard replaces it with its own.
  it("ignores the caller's own lookup", async () => {
    const host = await child([`localhost:${undeclared.port}`, `localhost:${declared.port}`]);
    // Ask for "localhost" on the declared port, but resolve it ourselves to
    // an address the list never names. The guard's lookup wins.
    const report = await probe(
      host,
      'tcpConnectWithLookup',
      'localhost',
      declared.port,
      '10.255.255.1'
    );
    expect(report.ok).toBe(true);
  });

  // Purpose: rewriting the prototypes a naive guard leans on does not open
  // an undeclared connection. Here `toLowerCase` claims every host is the
  // declared address: a guard that trusted it would let "evil.invalid" through
  // to DNS (ENOTFOUND); this one refuses it outright.
  it('stays shut after prototype tampering', async () => {
    const host = await child();
    expect(
      await probe(host, 'tamperThenConnect', 'evil.invalid', declared.port, '127.0.0.1')
    ).toMatchObject({ ok: false, code: DENIED });
    expect(
      await probe(host, 'tamperThenConnect', '127.0.0.1', undeclared.port, '127.0.0.1')
    ).toMatchObject({ ok: false, code: DENIED });
    expect(undeclared.count()).toBe(0);
    expect(
      await runControl(h, 'tamperThenConnect', '127.0.0.1', undeclared.port, '127.0.0.1')
    ).toEqual({ ok: true, value: 'connected' });
  });

  // Purpose: a raw native handle (constructor from an allowed socket, request
  // object from async_hooks) cannot connect around net.Socket; the control
  // shows the same trick does connect when nothing guards the handle.
  it('refuses a raw handle connect around net.Socket', async () => {
    const host = await child();
    const report = await probe(
      host,
      'rawHandleConnect',
      '127.0.0.1',
      declared.port,
      '127.0.0.1',
      undeclared.port
    );
    expect(report.ok).toBe(false);
    expect(String(report.code)).toMatch(/^errno:-/);
    expect(undeclared.count()).toBe(0);
    const control = await runControl(
      h,
      'rawHandleConnect',
      '127.0.0.1',
      declared.port,
      '127.0.0.1',
      undeclared.port
    );
    expect(control).toEqual({ ok: true, value: 'completed:0' });
  });

  // Purpose: a Unix socket is never a destination; the control connects.
  it.skipIf(process.platform === 'win32')('refuses Unix sockets', async () => {
    const sock = path.join(h.tmp, 's.sock');
    const server = net.createServer((s) => s.end());
    h.servers.push(server);
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    const host = await child();
    expect(await probe(host, 'unixSocket', sock)).toMatchObject({ ok: false, code: DENIED });
    expect(await runControl(h, 'unixSocket', sock)).toEqual({ ok: true, value: 'connected' });
    await fs.rm(sock, { force: true });
  });
});
