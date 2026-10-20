/**
 * The Wi-Fi listener is a second front-door server, and it must mark every
 * request and upgrade it takes, so the request classifier names a phone on
 * Wi-Fi by its route. Real sockets, because an upgrade never runs the request
 * handler and so needs its own mark.
 */
import { once } from 'node:events';
import type { IncomingMessage, Server } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

import { createFrontDoorServer } from '../front-door.js';
import type { ApiEnv } from '../api-chain.js';
import { ingressOf, type IngressKind } from '../../services/core/remote/ingress-mark.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});

/**
 * A front-door server on loopback whose one route reports the request's
 * ingress. `peer` overrides the TCP peer every connection reports, so a device
 * on the network can be played without a second interface.
 */
async function serve(
  ingress?: IngressKind,
  peer?: string
): Promise<{ port: number; upgrades: IncomingMessage[] }> {
  const app = new Hono<ApiEnv>();
  app.get('/ingress', (c) => c.json({ ingress: ingressOf(c.env.incoming) }));
  const server = createFrontDoorServer(app, ingress ? { ingress } : {});
  if (peer) {
    server.prependListener('connection', (socket: net.Socket) => {
      Object.defineProperty(socket, 'remoteAddress', { value: peer, configurable: true });
    });
  }
  const upgrades: IncomingMessage[] = [];
  server.on('upgrade', (req: IncomingMessage, socket: net.Socket) => {
    upgrades.push(req);
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: (server.address() as AddressInfo).port, upgrades };
}

/** Send one raw upgrade and wait for the server to hang up. */
async function upgrade(port: number): Promise<void> {
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => {});
  await once(socket, 'connect');
  socket.write(
    'GET /api/events HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
  );
  socket.resume();
  await once(socket, 'close');
}

describe('createFrontDoorServer ingress marking', () => {
  // Purpose: a request from another machine through the Wi-Fi listener must
  // read as `wifi`, or the classifier can only say "network" and session route
  // binding has nothing to bind to.
  it('marks requests and upgrades from another machine on the Wi-Fi listener', async () => {
    const { port, upgrades } = await serve('wifi', '192.168.1.40');
    const res = await fetch(`http://127.0.0.1:${port}/ingress`);
    expect(await res.json()).toEqual({ ingress: 'wifi' });

    await upgrade(port);
    expect(upgrades).toHaveLength(1);
    expect(ingressOf(upgrades[0]!)).toBe('wifi');
  });

  // Purpose: the Wi-Fi listener binds every interface while the main one binds
  // `::1` on macOS, so a client dialing 127.0.0.1 (the desktop shell, a tab at
  // 127.0.0.1) lands here. It is this computer and must stay unmarked.
  it('leaves a loopback peer on the Wi-Fi listener unmarked', async () => {
    for (const peer of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) {
      const { port, upgrades } = await serve('wifi', peer);
      const res = await fetch(`http://127.0.0.1:${port}/ingress`);
      expect(await res.json()).toEqual({ ingress: 'direct' });
      await upgrade(port);
      expect(ingressOf(upgrades[0]!)).toBe('direct');
    }
  });

  // Purpose: the main listener marks nothing, whoever connects.
  it('marks nothing on the main listener', async () => {
    const { port, upgrades } = await serve(undefined, '192.168.1.40');
    const res = await fetch(`http://127.0.0.1:${port}/ingress`);
    expect(await res.json()).toEqual({ ingress: 'direct' });

    await upgrade(port);
    expect(ingressOf(upgrades[0]!)).toBe('direct');
  });
});
