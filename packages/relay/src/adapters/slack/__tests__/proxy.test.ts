/**
 * Real-mechanism coverage for the Slack corporate-proxy transport (DOR-1542).
 *
 * `slack-adapter.test.ts` only asserts that a `fetch`/`dispatcher` option
 * gets passed to the mocked SDKs — it never proves that fetching through the
 * returned transport actually reaches a proxy. Deleting `dispatcher` from the
 * fetch closure in `proxy.ts` left all of that suite green, because
 * `typeof fetch === 'function'` is true either way.
 *
 * This file drives the real mechanism against a local HTTP CONNECT server —
 * no `vi.mock`, no real network. A forward proxy tunnels an HTTPS request by
 * receiving a plain-HTTP `CONNECT host:port` line before any TLS happens, so
 * a bare `http.createServer` listening for Node's `'connect'` event is a
 * complete stand-in for a real corporate proxy for this purpose: we only need
 * to observe which authority the client asked to tunnel to, not complete a
 * real backend round trip.
 *
 * @module relay/adapters/slack/__tests__/proxy
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { Socket, AddressInfo } from 'node:net';
import { createSlackProxyTransport, hasProxyEnv } from '../proxy.js';

/** A local stand-in for a forward proxy: records the authority of every CONNECT it sees. */
interface ConnectProxy {
  readonly port: number;
  readonly connects: string[];
  close(): Promise<void>;
}

/** Starts a proxy that records each `CONNECT host:port` it receives and immediately drops the socket. */
async function startConnectProxy(): Promise<ConnectProxy> {
  const connects: string[] = [];
  const server: Server = createServer((_req, res) => {
    // A plain (non-CONNECT) request reaching this handler is not what any of
    // these tests expect — respond so the client fails fast instead of hanging.
    res.writeHead(501).end();
  });
  server.on('connect', (req: IncomingMessage, socket: Socket) => {
    connects.push(req.url ?? '');
    // Complete the tunnel handshake, then drop it — no real upstream exists
    // to forward to. This matters: destroying the socket *without* replying
    // "200 Connection Established" reads to undici's ProxyAgent as a
    // transient failure to open the tunnel, and it retries in a tight loop
    // (tens of thousands of CONNECTs/sec) rather than surfacing an error —
    // observed directly while writing this test. Completing the handshake
    // first means the subsequent break happens one layer up, during the TLS
    // handshake that never gets attempted here, which undici does treat as
    // terminal: the fetch rejects in single-digit milliseconds, once.
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const { port } = server.address() as AddressInfo;
  return {
    port,
    connects,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Binds a server to a free loopback port, then closes it — the port is (best-effort) closed right after. */
async function reserveClosedLoopbackPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe('createSlackProxyTransport (real mechanism)', () => {
  const proxies: ConnectProxy[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(proxies.splice(0).map((p) => p.close()));
  });

  it('returns null, and hasProxyEnv() is false, when no proxy env var is set', () => {
    expect(hasProxyEnv()).toBe(false);
    expect(createSlackProxyTransport()).toBeNull();
  });

  it('HTTP_PROXY: the returned fetch tunnels an https request through the proxy via CONNECT', async () => {
    const proxy = await startConnectProxy();
    proxies.push(proxy);
    vi.stubEnv('HTTP_PROXY', `http://127.0.0.1:${proxy.port}`);

    const transport = createSlackProxyTransport();
    expect(transport).not.toBeNull();

    // The target host/port never needs to be reachable: a forward proxy
    // resolves and connects to it, the client only ever talks to the proxy.
    await transport!.fetch('https://slack.invalid.test:443/api/auth.test').catch(() => {
      // Expected: the tunnel socket was destroyed with no TLS behind it.
    });

    expect(proxy.connects).toEqual(['slack.invalid.test:443']);
  });

  it('HTTPS_PROXY: the returned fetch tunnels an https request through the proxy via CONNECT', async () => {
    const proxy = await startConnectProxy();
    proxies.push(proxy);
    vi.stubEnv('HTTPS_PROXY', `http://127.0.0.1:${proxy.port}`);

    const transport = createSlackProxyTransport();
    expect(transport).not.toBeNull();

    await transport!.fetch('https://slack.invalid.test:443/api/auth.test').catch(() => {});

    expect(proxy.connects).toEqual(['slack.invalid.test:443']);
  });

  it('NO_PROXY alone does not create a transport — hasProxyEnv() stays false (DOR-1542 review, F5)', () => {
    vi.stubEnv('NO_PROXY', 'slack.invalid.test');
    expect(hasProxyEnv()).toBe(false);
    expect(createSlackProxyTransport()).toBeNull();
  });

  it('NO_PROXY set alongside HTTPS_PROXY bypasses the proxy for a matching host — direct request, not proxied', async () => {
    const proxy = await startConnectProxy();
    proxies.push(proxy);
    const closedPort = await reserveClosedLoopbackPort();
    vi.stubEnv('HTTPS_PROXY', `http://127.0.0.1:${proxy.port}`);
    vi.stubEnv('NO_PROXY', '127.0.0.1');

    const transport = createSlackProxyTransport();
    expect(transport).not.toBeNull();

    // NO_PROXY covers the target host, so EnvHttpProxyAgent routes this
    // through its no-proxy Agent — a direct connection attempt to a closed
    // loopback port, which fails immediately (ECONNREFUSED) with no DNS
    // lookup and no real network involved.
    await expect(
      transport!.fetch(`https://127.0.0.1:${closedPort}/api/auth.test`)
    ).rejects.toBeDefined();

    expect(proxy.connects).toEqual([]);
  });
});
