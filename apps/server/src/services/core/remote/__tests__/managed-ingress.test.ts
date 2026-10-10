/**
 * The managed ingress, over real sockets: every edge check runs before the app,
 * a refused request never reaches a route, and the proof never reaches the app.
 *
 * Requests are written byte-for-byte on a raw socket, because the cases that
 * matter most — two copies of the proof header — are exactly what an HTTP
 * client library would quietly merge or reject before sending.
 */
import net from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_EDGE_PROOF_OVERLAP_SECONDS } from '@dork-labs/cloud-api';
import { isLocalCaller } from '../../../../lib/caller-authority.js';
import { createManagedIngress, type ManagedIngress } from '../managed-ingress.js';
import { isManagedIngress } from '../ingress-mark.js';

const PROOF = { header: 'x-dorkos-edge', secret: 's'.repeat(48) };
const HOST = 'abc.remote.example';

interface RawResponse {
  status: number;
  head: string;
  body: string;
}

/** Write one raw HTTP/1.1 request and read until the server closes. */
function rawRequest(port: number, lines: string[], upgrade = false): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => (data += chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      const [head = '', body = ''] = data.split('\r\n\r\n');
      resolve({ status: Number(head.split(' ')[1]), head, body });
    });
    const connection = upgrade ? 'Connection: Upgrade' : 'Connection: close';
    socket.write([...lines, connection, '', ''].join('\r\n'));
  });
}

function get(port: number, path: string, headers: string[]): Promise<RawResponse> {
  return rawRequest(port, [`GET ${path} HTTP/1.1`, ...headers]);
}

const proofHeader = `X-DorkOS-Edge: ${PROOF.secret}`;
const hostHeader = `Host: ${HOST}`;

let ingress: ManagedIngress;
let port: number;
let routeSpy: ReturnType<typeof vi.fn<(path: string) => void>>;
let forwardUpgrade: ReturnType<
  typeof vi.fn<(req: IncomingMessage, socket: Duplex, head: Buffer) => void>
>;
let now = 1_000_000;
let seenHeaders: { raw: string[]; parsed: Record<string, unknown> } | null;

beforeEach(async () => {
  routeSpy = vi.fn();
  seenHeaders = null;
  const app = express();
  app.use((req, res, next) => {
    routeSpy(req.path);
    seenHeaders = { raw: [...req.rawHeaders], parsed: { ...req.headers } };
    next();
  });
  app.get('/whoami', (req, res) => {
    res.json({
      local: isLocalCaller(req),
      ingress: res.locals.ingress,
      marked: isManagedIngress(req),
    });
  });
  app.get('/slow', (_req, res) => {
    setTimeout(() => res.json({ done: true }), 150);
  });
  app.use((_req, res) => res.status(200).json({ reached: true }));

  forwardUpgrade = vi.fn((_req: IncomingMessage, socket: Duplex, _head: Buffer) => {
    socket.destroy();
  });
  ingress = createManagedIngress({ handler: app, forwardUpgrade, now: () => now });
  const url = await ingress.open();
  port = Number(new URL(url).port);
  ingress.setHosts([HOST]);
  ingress.setEdgeProof(PROOF);
});

afterEach(async () => {
  await ingress.close({ immediate: true });
});

describe('edge proof on HTTP requests', () => {
  it('admits exactly one matching copy and strips it before the app', async () => {
    const res = await get(port, '/anything', [hostHeader, proofHeader]);
    expect(res.status).toBe(200);
    expect(routeSpy).toHaveBeenCalledTimes(1);
    expect(seenHeaders!.parsed).not.toHaveProperty(PROOF.header);
    expect(seenHeaders!.raw.map((h) => h.toLowerCase())).not.toContain(PROOF.header);
    expect(seenHeaders!.raw).not.toContain(PROOF.secret);
  });

  it('leaves no trace of the proof in headersDistinct either', async () => {
    let distinct: Record<string, unknown> | null = null;
    const app = express();
    app.use((req, res) => {
      distinct = { ...req.headersDistinct };
      res.end();
    });
    await ingress.close({ immediate: true });
    ingress = createManagedIngress({ handler: app, forwardUpgrade, now: () => now });
    port = Number(new URL(await ingress.open()).port);
    ingress.setHosts([HOST]);
    ingress.setEdgeProof(PROOF);
    expect((await get(port, '/x', [hostHeader, proofHeader])).status).toBe(200);
    expect(distinct).not.toBeNull();
    expect(distinct!).not.toHaveProperty(PROOF.header);
    expect(JSON.stringify(distinct)).not.toContain(PROOF.secret);
  });

  it('checks every pipelined request on one connection on its own', async () => {
    const res = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      let data = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => (data += chunk));
      socket.on('error', reject);
      socket.on('close', () => resolve(data));
      socket.write(
        [
          'GET /first HTTP/1.1',
          hostHeader,
          proofHeader,
          '',
          'GET /second HTTP/1.1',
          hostHeader,
          'Connection: close',
          '',
          '',
        ].join('\r\n')
      );
    });
    const statuses = [...res.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => Number(m[1]));
    expect(statuses).toEqual([200, 403]);
    expect(routeSpy).toHaveBeenCalledTimes(1);
    expect(routeSpy).toHaveBeenCalledWith('/first');
  });

  it('refuses a bad proof before answering 100 Continue', async () => {
    const res = await rawRequest(port, [
      'POST /anything HTTP/1.1',
      hostHeader,
      'X-DorkOS-Edge: nope',
      'Expect: 100-continue',
      'Content-Length: 5',
    ]);
    expect(res.head).not.toContain('100 Continue');
    expect(res.status).toBe(403);
    expect(routeSpy).not.toHaveBeenCalled();
  });

  it('answers 100 Continue only once the checks pass', async () => {
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      let data = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        data += chunk;
        if (data.includes('100 Continue') && !data.includes('200')) socket.write('hello');
      });
      socket.on('error', reject);
      socket.on('close', () => resolve(data));
      socket.write(
        [
          'POST /anything HTTP/1.1',
          hostHeader,
          proofHeader,
          'Expect: 100-continue',
          'Content-Length: 5',
          'Connection: close',
          '',
          '',
        ].join('\r\n')
      );
    });
    expect(reply).toMatch(/^HTTP\/1\.1 100 Continue/);
    expect(reply).toContain('HTTP/1.1 200');
  });

  it.each([
    ['no copy', [hostHeader]],
    ['two matching copies', [hostHeader, proofHeader, proofHeader]],
    ['a wrong value', [hostHeader, 'X-DorkOS-Edge: nope']],
    ['a matching and a wrong copy', [hostHeader, 'X-DorkOS-Edge: nope', proofHeader]],
  ])('refuses %s with 403, and no route ever runs', async (_label, headers) => {
    const res = await get(port, '/anything', headers);
    expect(res.status).toBe(403);
    expect(res.body).not.toContain(PROOF.secret);
    expect(routeSpy).not.toHaveBeenCalled();
  });

  it('accepts the previous secret only inside the overlap window', async () => {
    const next = { header: PROOF.header, secret: 'n'.repeat(48) };
    ingress.setEdgeProof(next, now);
    expect((await get(port, '/a', [hostHeader, proofHeader])).status).toBe(200);
    expect((await get(port, '/a', [hostHeader, `x-dorkos-edge: ${next.secret}`])).status).toBe(200);
    now += REMOTE_EDGE_PROOF_OVERLAP_SECONDS * 1000;
    expect((await get(port, '/a', [hostHeader, proofHeader])).status).toBe(403);
  });
});

describe('host and path checks', () => {
  it('refuses a Host managed access does not serve', async () => {
    const res = await get(port, '/anything', ['Host: other.example', proofHeader]);
    expect(res.status).toBe(421);
    expect(routeSpy).not.toHaveBeenCalled();
  });

  it('compares the Host without regard to case', async () => {
    const res = await get(port, '/anything', [`Host: ${HOST.toUpperCase()}:443`, proofHeader]);
    expect(res.status).toBe(200);
  });

  it('refuses Host: localhost, so a forged local Host never reaches the app', async () => {
    const res = await get(port, '/whoami', ['Host: localhost', proofHeader]);
    expect(res.status).toBe(421);
    expect(routeSpy).not.toHaveBeenCalled();
  });

  it.each([
    '/a2a',
    '/a2a/',
    '/A2A',
    '/A2A/rpc',
    '/a2a?x=1',
    '/%61%32a',
    '/%41%32%41/rpc',
    '/.well-known/agent-card.json',
    '/.well-known/agent.json',
    '/.WELL-KNOWN/Agent.json',
    '/.well-known/agent.json/',
    '/.well-known/%61gent.json',
  ])('refuses %s on the managed listener', async (path) => {
    const res = await get(port, path, [hostHeader, proofHeader]);
    expect(res.status).toBe(404);
    expect(routeSpy).not.toHaveBeenCalled();
  });

  // Express routes by `parseurl`, which reads all of these as an agent path.
  it.each([
    '/a2a#x',
    '/a2a/#',
    `http://${HOST}/a2a`,
    `HTTP://${HOST}/A2A/`,
    `http://${HOST}/.well-known/agent.json`,
    `http://${HOST}/.well-known/agent-card.json?x`,
    `http://${HOST}/%61%32a`,
    `http://${HOST}/anything`,
    '*',
  ])('refuses the non-origin-form target %s before routing', async (target) => {
    const res = await get(port, target, [hostHeader, proofHeader]);
    expect(res.status).toBe(400);
    expect(routeSpy).not.toHaveBeenCalled();
  });

  it('refuses two Host headers rather than trusting the first', async () => {
    const res = await get(port, '/anything', [hostHeader, 'Host: other.example', proofHeader]);
    expect(res.status).toBe(400);
    expect(routeSpy).not.toHaveBeenCalled();
  });
});

describe('locality', () => {
  it('is never local, even when the served host is loopback and the peer is loopback', async () => {
    ingress.setHosts(['localhost']);
    const res = await get(port, '/whoami', ['Host: localhost', proofHeader]);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ local: false, ingress: 'managed', marked: true });
  });
});

describe('WebSocket upgrades', () => {
  const upgradeLines = (extra: string[]) => [
    'GET /api/events/socket HTTP/1.1',
    ...extra,
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
  ];

  it('hands an upgrade with a valid proof to the router, stripped and marked', async () => {
    await rawRequest(port, upgradeLines([hostHeader, proofHeader]), true);
    expect(forwardUpgrade).toHaveBeenCalledTimes(1);
    const req = forwardUpgrade.mock.calls[0]![0] as IncomingMessage;
    expect(req.headers).not.toHaveProperty(PROOF.header);
    expect(isManagedIngress(req)).toBe(true);
  });

  it.each([
    ['no copy', [hostHeader]],
    ['two copies', [hostHeader, proofHeader, proofHeader]],
    ['a wrong value', [hostHeader, 'X-DorkOS-Edge: nope']],
    ['a Host not served', ['Host: other.example', proofHeader]],
  ])('refuses an upgrade with %s and never reaches the router', async (_label, headers) => {
    const res = await rawRequest(port, upgradeLines(headers), true);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(forwardUpgrade).not.toHaveBeenCalled();
  });
});

describe('drain and close', () => {
  it('answers 503 to new requests while an admitted one finishes', async () => {
    const slow = get(port, '/slow', [hostHeader, proofHeader]);
    await vi.waitFor(() => expect(ingress.inFlight).toBe(1));
    ingress.beginDrain();
    const late = await get(port, '/anything', [hostHeader, proofHeader]);
    expect(late.status).toBe(503);
    const finished = await slow;
    expect(finished.status).toBe(200);
    expect(JSON.parse(finished.body)).toEqual({ done: true });
  });

  it('a gentle close waits for admitted work; the port then stops answering', async () => {
    const slow = get(port, '/slow', [hostHeader, proofHeader]);
    await vi.waitFor(() => expect(ingress.inFlight).toBe(1));
    await ingress.close({ immediate: false });
    expect((await slow).status).toBe(200);
    await expect(get(port, '/anything', [hostHeader, proofHeader])).rejects.toThrow();
  });

  it('an immediate close cuts admitted work and outranks a gentle close', async () => {
    const slow = get(port, '/slow', [hostHeader, proofHeader]).catch(() => null);
    await vi.waitFor(() => expect(ingress.inFlight).toBe(1));
    const gentle = ingress.close({ immediate: false });
    await ingress.close({ immediate: true });
    await gentle;
    const res = await slow;
    expect(res === null || Number.isNaN(res.status)).toBe(true);
  });

  it('forgets hosts and proof on close, so a reopen admits nothing until configured', async () => {
    await ingress.close({ immediate: true });
    port = Number(new URL(await ingress.open()).port);
    expect((await get(port, '/anything', [hostHeader, proofHeader])).status).toBe(503);
  });
});
