import { afterEach, describe, expect, it } from 'vitest';
import http, { type IncomingMessage } from 'node:http';
import net from 'node:net';
import { createOwnTunnelIngress, type OwnTunnelIngress } from '../own-tunnel-ingress.js';
import { ingressOf } from '../ingress-mark.js';

const opened: OwnTunnelIngress[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((ingress) => ingress.close()));
});

/** An ingress whose handler and upgrade target record what they were handed. */
function recordingIngress(frontedPort: number | null = 4242) {
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
    frontedPort: () => frontedPort,
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
  it('fronts only the main server port, and nothing before it listens', () => {
    expect(recordingIngress(4242).ingress.fronts(4242)).toBe(true);
    expect(recordingIngress(4242).ingress.fronts(6241)).toBe(false);
    expect(recordingIngress(null).ingress.fronts(4242)).toBe(false);
  });
});
