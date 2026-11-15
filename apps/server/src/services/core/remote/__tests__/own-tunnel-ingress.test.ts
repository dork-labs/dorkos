import { afterEach, describe, expect, it } from 'vitest';
import http, { type IncomingMessage } from 'node:http';
import net from 'node:net';
import { createOwnTunnelIngress, type OwnTunnelIngress } from '../own-tunnel-ingress.js';
import { ingressOf } from '../ingress-mark.js';
import { APP_OWN_ROUTES, RETIRED_ENCODED_PATHS } from './app-own-routes.js';

const opened: OwnTunnelIngress[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((ingress) => ingress.close()));
});

/** An ingress whose handler and upgrade target record what they were handed. */
function recordingIngress(frontedPort = 4242) {
  const requests: IncomingMessage[] = [];
  const upgrades: IncomingMessage[] = [];
  const ingress = createOwnTunnelIngress({
    handler: (req, res) => {
      requests.push(req);
      res.end(JSON.stringify({ ingress: ingressOf(req), host: req.headers.host }));
    },
    forwardUpgrade: (req, socket) => {
      upgrades.push(req);
      socket.end(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n'
      );
    },
    frontedPort,
  });
  opened.push(ingress);
  return { ingress, requests, upgrades };
}

/** GET a path with a chosen `Host`, the way the ngrok agent forwards one. */
function get(url: string, host: string): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: target.hostname, port: target.port, path: '/api/health', headers: { host } },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** Send one raw request line and read back its status code. */
function rawStatus(port: number, target: string, upgrade = false, method = 'GET'): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        `${method} ${target} HTTP/1.1\r\nHost: abc.ngrok.app\r\n` +
          (upgrade ? 'Connection: Upgrade\r\nUpgrade: websocket\r\n' : 'Connection: close\r\n') +
          '\r\n'
      );
    });
    let head = '';
    socket.on('data', (chunk) => {
      head += chunk.toString();
      const match = /^HTTP\/1\.1 (\d{3})/.exec(head);
      if (match) {
        resolve(Number(match[1]));
        socket.destroy();
      }
    });
    socket.on('error', reject);
  });
}

/** The six spellings that reached /a2a or an agent card before (Security, Nov 11). */
export const DOT_SEGMENT_SPELLINGS = [
  '/x/../a2a',
  '/x/%2e%2e/a2a',
  '/x/%2E%2E/A2A/agents',
  '/api/connectors/webhooks/../../../a2a',
  '/api/relay/webhooks/x/..%2f..%2f..%2f..%2fa2a',
  '/x/./../.well-known/agent-card.json',
];

/**
 * The spellings Cloud's edge filter is tested on (Nov 11), so both filters are
 * held to the same set: these normalise to a refused path (404) ...
 */
const EDGE_SPELLINGS_NOT_SERVED = ['//a2a', '/%61%32%61', '/./a2a', '/.well-known/./agent'];
/** ... and these carry an encoded `/`, so they are not a normal path (400). */
const EDGE_SPELLINGS_NOT_NORMAL = ['/x/..%2fa2a', '/.%2fa2a'];

describe('own-tunnel ingress: normalise, then match', () => {
  it.each([
    '/a2a',
    '/A2A/rpc',
    '/a2a/agents/x/card',
    '/%61%32%61',
    '/.well-known/agent-card.json',
    '/.well-known/agent.json?x=1',
    ...EDGE_SPELLINGS_NOT_SERVED,
  ])('refuses %s with 404 and never hands it on', async (target) => {
    const { ingress, requests } = recordingIngress();
    const port = Number(new URL(await ingress.open()).port);
    expect(await rawStatus(port, target)).toBe(404);
    expect(requests).toHaveLength(0);
  });

  it('refuses a target that is not a plain path with 400', async () => {
    const { ingress, requests } = recordingIngress();
    const port = Number(new URL(await ingress.open()).port);
    expect(await rawStatus(port, 'http://abc.ngrok.app/a2a')).toBe(400);
    expect(await rawStatus(port, '/a2a#x')).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it.each([
    ...DOT_SEGMENT_SPELLINGS,
    ...RETIRED_ENCODED_PATHS,
    ...EDGE_SPELLINGS_NOT_NORMAL,
    '/x/%252e%252e/a2a',
    '/x\\..\\a2a',
    '/api/x%5c..%5ca2a',
    '/%ZZ',
  ])('rejects %s with 400: not a normal path, never guessed', async (target) => {
    const { ingress, requests } = recordingIngress();
    const port = Number(new URL(await ingress.open()).port);
    expect(await rawStatus(port, target)).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it('refuses an upgrade the same way', async () => {
    const { ingress, upgrades } = recordingIngress();
    const port = Number(new URL(await ingress.open()).port);
    expect(await rawStatus(port, '/x/../a2a', true)).toBe(400);
    expect(await rawStatus(port, '/a2a', true)).toBe(404);
    expect(upgrades).toHaveLength(0);
  });

  it.each([
    '/',
    '/api/health',
    '/sw.js',
    '/manifest.webmanifest',
    '/.well-known/security.txt',
    // Open until Security rules otherwise: outside services reach this computer only here.
    '/api/connectors/webhooks/cpi_abc',
    '/api/relay/webhooks/made-up',
    // Key-only from another device (mcp-auth), as the docs offer.
    '/mcp',
  ])('still hands the app’s own %s to the front door', async (target) => {
    const { ingress, requests } = recordingIngress();
    const port = Number(new URL(await ingress.open()).port);
    expect(await rawStatus(port, target)).toBe(200);
    expect(requests).toHaveLength(1);
  });
});

describe('own-tunnel ingress: the app’s own routes (DOR-4212)', () => {
  it.each(APP_OWN_ROUTES)('hands $method $target to the front door', async (route) => {
    const { ingress, requests } = recordingIngress();
    const port = Number(new URL(await ingress.open()).port);
    expect(await rawStatus(port, route.target, false, route.method)).toBe(200);
    expect(requests).toHaveLength(1);
  });
});

describe('own-tunnel ingress', () => {
  // Purpose: the whole reason the listener exists. The ngrok agent connects
  // from loopback, so a request reaching the front door from here must carry
  // the own-tunnel mark even when its Host was rewritten to localhost.
  it('marks every request it hands to the front door, whatever its Host', async () => {
    const { ingress, requests } = recordingIngress();
    const url = await ingress.open();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const rewritten = await get(url, 'localhost:4242');
    const publicHost = await get(url, 'abc.ngrok.app');

    expect(JSON.parse(rewritten.body)).toEqual({ ingress: 'own-tunnel', host: 'localhost:4242' });
    expect(JSON.parse(publicHost.body)).toEqual({ ingress: 'own-tunnel', host: 'abc.ngrok.app' });
    expect(requests).toHaveLength(2);
  });

  // Purpose: WebSocket upgrades skip the request handler, so they need their
  // own mark before the upgrade router sees them, or a terminal socket through
  // the tunnel would read as this computer.
  it('marks every upgrade it hands to the upgrade router', async () => {
    const { ingress, upgrades } = recordingIngress();
    const port = Number(new URL(await ingress.open()).port);

    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(
          'GET /api/terminal HTTP/1.1\r\nHost: localhost:4242\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
        );
      });
      socket.on('data', () => socket.end());
      socket.on('close', () => resolve());
      socket.on('error', reject);
    });

    expect(upgrades).toHaveLength(1);
    expect(ingressOf(upgrades[0]!)).toBe('own-tunnel');
  });

  // Purpose: a stopped tunnel must leave nothing listening, and an upgraded
  // socket (which closeAllConnections does not track) must be cut too.
  it('stops listening and cuts open sockets on close', async () => {
    const { ingress } = recordingIngress();
    const port = Number(new URL(await ingress.open()).port);
    const held = net.connect(port, '127.0.0.1');
    // Being cut is the point; the reset it reads is expected.
    held.on('error', () => {});
    await new Promise((resolve) => held.once('connect', resolve));
    const heldClosed = new Promise((resolve) => held.once('close', resolve));

    await ingress.close();
    await heldClosed;

    await expect(get(`http://127.0.0.1:${port}`, 'localhost')).rejects.toThrow();
  });

  // Purpose: open is idempotent, so two starts never leave two listeners.
  it('reuses the open listener', async () => {
    const { ingress } = recordingIngress();
    const [a, b] = await Promise.all([ingress.open(), ingress.open()]);
    expect(a).toBe(b);
    expect(await ingress.open()).toBe(a);
  });

  // Purpose: the ingress only fronts the main server's own port; a tunnel aimed
  // at the Vite dev server or an operator's TUNNEL_PORT must forward directly.
  it('fronts only the main server port', () => {
    expect(recordingIngress(4242).ingress.fronts(4242)).toBe(true);
    expect(recordingIngress(4242).ingress.fronts(6241)).toBe(false);
  });
});

describe('dropConnections (Remote Access off, DOR-3650)', () => {
  it('cuts a kept-alive connection now and keeps listening', async () => {
    const { ingress } = recordingIngress();
    const port = Number(new URL(await ingress.open()).port);
    const socket = net.connect(port, '127.0.0.1');
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write(
      'GET /api/health HTTP/1.1\r\nHost: abc.ngrok.app\r\nConnection: keep-alive\r\n\r\n'
    );
    await new Promise((resolve) => socket.once('data', resolve));
    const closed = new Promise((resolve) => socket.once('close', resolve));

    ingress.dropConnections();

    await closed;
    expect(await rawStatus(port, '/api/health')).toBe(200);
  });
});
