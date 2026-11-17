import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Set the app home before the server modules evaluate; no real profile or
// global home override participates in this fixture.
const appHome = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = await mkdtemp(join(tmpdir(), 'extension-body-limit-'));
  vi.stubEnv('DORK_HOME', home);
  return home;
});

import { rm } from 'node:fs/promises';
import { initConfigManager } from '../../../core/config-manager.js';
import { bodyLimitFixture, bodyRequest, type BodyReply } from './body-limit-fixture.js';

const f = bodyLimitFixture();
beforeAll(() => {
  initConfigManager(appHome);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(appHome, { recursive: true, force: true });
});
beforeEach(() => f.serve());
const LIMIT = 1024 * 1024;

function expectRefusal(reply: BodyReply) {
  expect(reply.status).toBe(413);
  expect(reply.body).toEqual({ error: 'That request is too large.' });
  expect(reply.complete).toBe(true);
  expect(reply.headers.connection).toBe('close');
  expect(reply.headers['content-length']).toBe('38');
  expect(reply.headers['x-content-type-options']).toBe('nosniff');
  expect(reply.headers['content-security-policy']).toContain("frame-ancestors 'none'");
}

describe('oversized extension request delivery', () => {
  it('delivers the whole refusal without ending a response over unread input', async () => {
    const { request, response } = bodyRequest(f.server, null, { declared: LIMIT + 1 });
    try {
      expectRefusal(await response);
      expect(f.exchanges).toHaveLength(1);
      expect(f.exchanges[0]!.finishedBeforeInputEnd).toBe(false);
      expect(f.handler).not.toHaveBeenCalled();
    } finally {
      request.destroy();
    }
    await f.exchanges[0]!.closed;
  });

  it.each([false, true])('fully answers an eager oversized body (chunked: %s)', async (chunked) => {
    const { response } = bodyRequest(f.server, Buffer.alloc(LIMIT + 1, 120), { chunked });
    expectRefusal(await response);
    expect(f.handler).not.toHaveBeenCalled();
    await f.exchanges[0]!.closed;
    expect(f.exchanges[0]!.finishedBeforeInputEnd).toBe(false);
    const small = await bodyRequest(f.server, 'valid').response;
    expect(small.status).toBe(200);
    expect(small.body).toEqual({ bytes: 5 });
    expect(f.handler).toHaveBeenCalledOnce();
  });

  it('accepts exactly the limit and invokes the real handler once', async () => {
    const reply = await bodyRequest(f.server, Buffer.alloc(LIMIT, 120)).response;
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ bytes: LIMIT });
    expect(reply.complete).toBe(true);
    expect(f.handler).toHaveBeenCalledOnce();
  });

  it.each(['deadline', 'shutdown', 'peer abort'] as const)(
    'cleans up a stalled upload on %s after flushing its real refusal',
    async (exit) => {
      const socket = connect({
        host: '127.0.0.1',
        port: (f.server.address() as AddressInfo).port,
        allowHalfOpen: true,
      });
      try {
        await once(socket, 'connect');
        let text = '';
        const fullBody = new Promise<void>((resolve) =>
          socket.on('data', (chunk: Buffer) => {
            text += chunk.toString();
            const split = text.indexOf('\r\n\r\n');
            if (split !== -1 && Buffer.byteLength(text.slice(split + 4)) === 38) resolve();
          })
        );
        const ended = once(socket, 'end');
        socket.write(
          `PUT /api/ext/my-ext/notes HTTP/1.1\r\nHost: localhost\r\nContent-Type: text/plain\r\nContent-Length: ${LIMIT + 1}\r\n\r\n`
        );
        await fullBody;
        expect(text.split('\r\n')[0]).toContain('413');
        expect(JSON.parse(text.split('\r\n\r\n')[1]!)).toEqual({
          error: 'That request is too large.',
        });
        expect(f.exchanges[0]!.outgoing.writableEnded).toBe(false);
        if (exit === 'shutdown') f.server.closeAllConnections();
        else if (exit === 'peer abort') socket.end();
        if (exit !== 'peer abort') await ended;
        await f.exchanges[0]!.closed;
        expect(f.handler).not.toHaveBeenCalled();
        expect(f.exchanges[0]!.incoming.listenerCount('data')).toBe(0);
      } finally {
        socket.destroy();
      }
    }
  );

  it('settles a delayed empty chunked EOF without waiting for its disposal deadline', async () => {
    const socket = connect({
      host: '127.0.0.1',
      port: (f.server.address() as AddressInfo).port,
      allowHalfOpen: true,
    });
    try {
      await once(socket, 'connect');
      let text = '';
      const fullBody = new Promise<void>((resolve) =>
        socket.on('data', (chunk: Buffer) => {
          text += chunk.toString();
          const split = text.indexOf('\r\n\r\n');
          if (split !== -1 && Buffer.byteLength(text.slice(split + 4)) === 38) resolve();
        })
      );
      const ended = once(socket, 'end');
      socket.write(
        'PUT /api/ext/my-ext/notes HTTP/1.1\r\nHost: localhost\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n'
      );
      socket.write(`${(LIMIT + 1).toString(16)}\r\n`);
      socket.write(Buffer.alloc(LIMIT + 1, 120));
      socket.write('\r\n');
      await fullBody;
      expect(text.split('\r\n')[0]).toContain('413');
      expect(JSON.parse(text.split('\r\n\r\n')[1]!)).toEqual({
        error: 'That request is too large.',
      });
      const exchange = f.exchanges[0]!;
      await nextTurn();
      expect(exchange.incoming.readableLength).toBe(0);
      expect(exchange.outgoing.writableEnded).toBe(false);
      const eofReadable = once(exchange.incoming, 'readable');
      socket.write('0\r\n\r\n');
      await eofReadable;
      for (let turn = 0; turn < 3; turn++) await nextTurn();
      expect(exchange.incoming.readableEnded).toBe(true);
      expect(exchange.outgoing.writableEnded).toBe(true);
      await ended;
      await exchange.closed;
      expect(f.handler).not.toHaveBeenCalled();
    } finally {
      socket.destroy();
    }
  });

  it('rejects an actual truncated 413 instead of treating its status as a response', async () => {
    f.mount((_req, res) => {
      res.writeHead(413, {
        'content-type': 'application/json',
        'content-length': 38,
        connection: 'close',
      });
      res.end('{"error":');
    });
    await expect(bodyRequest(f.server, 'valid').response).rejects.toThrow();
    expect(f.handler).not.toHaveBeenCalled();
  });
});
