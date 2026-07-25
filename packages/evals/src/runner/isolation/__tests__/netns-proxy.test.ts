/**
 * The namespace proxy: the only path from the harness into a `--network none`
 * container. Driven over a real loopback socket with a FAKE channel, so the byte
 * relaying, the per-connection lifecycle, and the teardown are all exercised
 * without a docker daemon.
 *
 * The proxy is why the docker tier can claim containment at all — `--network none`
 * closes egress AND the host route, but it also makes `--publish` inert, so
 * reachability has to come from the container's namespace instead. If this file
 * is green and the real `docker exec` channel is broken, the docker tier fails
 * loudly at health-poll time rather than silently degrading; that path is covered
 * by hand against the real image, not here.
 */
import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import {
  startNetnsProxy,
  relayCeilingFor,
  PIDS_PER_RELAY,
  PIDS_RESERVED_FOR_WORKLOAD,
  type NetnsChannel,
  type OpenNetnsChannel,
} from '../netns-proxy.js';

/** Allocate a free loopback port by binding `:0` and releasing it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

/**
 * A recorded fake channel: echoes a canned reply and records what it was sent.
 *
 * @param reply - Bytes to write back when the request arrives.
 * @param opts.asyncReply - Answer on a later tick, the way a real server does.
 *   Required to exercise anything that depends on the response racing the
 *   client's FIN; a synchronous fake papers over exactly those bugs.
 */
function echoChannel(
  reply: string,
  opts: { asyncReply?: boolean } = {}
): {
  open: OpenNetnsChannel;
  channels: { sent: string[]; closed: boolean; stdinEnded: boolean }[];
} {
  const channels: { sent: string[]; closed: boolean; stdinEnded: boolean }[] = [];
  const open: OpenNetnsChannel = () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const record = { sent: [] as string[], closed: false, stdinEnded: false };
    channels.push(record);
    // The exec session's stdin reaching EOF is what used to kill the attach on a
    // client half-close; recording it makes that regression assertable.
    stdin.on('finish', () => {
      record.stdinEnded = true;
    });
    stdin.on('data', (chunk: Buffer) => {
      record.sent.push(chunk.toString());
      if (opts.asyncReply) {
        setTimeout(() => {
          stdout.write(reply);
          // A real server closes the connection after answering, which is what
          // ends the relay's stdout and lets the pipe close the client socket.
          stdout.end();
        }, 25);
      } else {
        stdout.write(reply);
      }
    });
    const channel: NetnsChannel = {
      stdin,
      stdout,
      stderr: new PassThrough(),
      close: () => {
        record.closed = true;
        stdout.end();
      },
    };
    return channel;
  };
  return { open, channels };
}

/** Send `payload` to the proxy and resolve with the first chunk it answers. */
function roundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(payload));
    socket.once('data', (chunk: Buffer) => {
      resolve(chunk.toString());
      socket.destroy();
    });
    socket.once('error', reject);
  });
}

describe('startNetnsProxy', () => {
  it('relays bytes in both directions between the host socket and the channel', async () => {
    const { open, channels } = echoChannel('HTTP/1.1 200 OK\r\n\r\nok');
    const port = await freePort();
    const proxy = await startNetnsProxy({ host: '127.0.0.1', port, containerId: 'c1', open });

    try {
      const answer = await roundTrip(port, 'GET /api/health HTTP/1.1\r\n\r\n');
      expect(answer).toContain('200 OK');
      expect(channels).toHaveLength(1);
      expect(channels[0].sent.join('')).toContain('GET /api/health');
    } finally {
      await proxy.close();
    }
  });

  it('reports the loopback base URL the harness drives', async () => {
    const { open } = echoChannel('x');
    const port = await freePort();
    const proxy = await startNetnsProxy({ host: '127.0.0.1', port, containerId: 'c1', open });
    expect(proxy.baseUrl).toBe(`http://127.0.0.1:${String(port)}`);
    await proxy.close();
  });

  it('opens ONE channel per connection, into the right container', async () => {
    const opened: { id: string; port: number }[] = [];
    const open: OpenNetnsChannel = (id, p) => {
      opened.push({ id, port: p });
      return {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        close: () => {},
      };
    };
    const port = await freePort();
    const proxy = await startNetnsProxy({ host: '127.0.0.1', port, containerId: 'deadbeef', open });

    try {
      for (let i = 0; i < 2; i++) {
        await new Promise<void>((resolve, reject) => {
          const socket = net.connect(port, '127.0.0.1', () => {
            socket.destroy();
            resolve();
          });
          socket.once('error', reject);
        });
      }
      // Sockets close asynchronously; give the server its 'connection' events.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(opened).toEqual([
        { id: 'deadbeef', port },
        { id: 'deadbeef', port },
      ]);
    } finally {
      await proxy.close();
    }
  });

  it('close() kills live channels and frees the port for the next eval', async () => {
    const { open, channels } = echoChannel('ok');
    const port = await freePort();
    const proxy = await startNetnsProxy({ host: '127.0.0.1', port, containerId: 'c1', open });
    await roundTrip(port, 'ping');
    await proxy.close();

    expect(channels[0].closed).toBe(true);
    // The port must be reusable: the harness may hand it to the next container.
    const rebound = net.createServer();
    await new Promise<void>((resolve, reject) => {
      rebound.once('error', reject);
      rebound.listen(port, '127.0.0.1', () => resolve());
    });
    await new Promise<void>((resolve) => rebound.close(() => resolve()));
  });

  it('close() is idempotent', async () => {
    const { open } = echoChannel('ok');
    const port = await freePort();
    const proxy = await startNetnsProxy({ host: '127.0.0.1', port, containerId: 'c1', open });
    await proxy.close();
    await expect(proxy.close()).resolves.toBeUndefined();
  });

  it('still delivers the response when the client HALF-CLOSES after its request', async () => {
    // A client FIN must not tear the exec session down. With pipe's default
    // `end: true` on the request side it did: a half-closing client got 0 bytes
    // where a normal one got a full 200. undici and node:http do not half-close,
    // which is why an end-to-end run stayed green over the bug.
    // The reply must be ASYNCHRONOUS, like a real server's. A fake that answers
    // synchronously on the request bytes gets its response out before the FIN is
    // processed, and so passes even with the bug — which is exactly why the first
    // version of this test missed `allowHalfOpen` and only a real container
    // caught it.
    const { open, channels } = echoChannel('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok', {
      asyncReply: true,
    });
    const port = await freePort();
    const proxy = await startNetnsProxy({ host: '127.0.0.1', port, containerId: 'c1', open });

    try {
      const received = await new Promise<string>((resolve, reject) => {
        let buf = '';
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.write('GET /api/health HTTP/1.1\r\nHost: x\r\n\r\n');
          // The half-close under test.
          socket.end();
        });
        socket.on('data', (c: Buffer) => {
          buf += c.toString();
        });
        socket.on('close', () => resolve(buf));
        socket.once('error', reject);
      });

      expect(received).toContain('HTTP/1.1 200 OK');
      expect(received).toContain('ok');
      // The precise regression guard: the client's FIN must NOT have propagated
      // to the exec session's stdin. With pipe's default `end: true` it did, the
      // attach came down before the reply, and `received` was empty.
      expect(channels[0].stdinEnded).toBe(false);
      expect(channels[0].sent.join('')).toContain('GET /api/health');
    } finally {
      await proxy.close();
    }
  });

  it('delivers a large backed-up body intact through a slow reader', async () => {
    // CHARACTERIZATION, NOT A REGRESSION GUARD — stated plainly because the
    // difference matters. The fix it accompanies (no `teardown` on stdout 'end',
    // so nothing `destroy()`s the socket immediately after the pipe's graceful
    // `end()`) rests on ORDERING, not on a reproduction: this test passes both
    // with and without that listener, at 512 KB and at 16 MB, with the reader
    // paused to force backpressure. Node appears to flush pending writes before
    // the destroy lands on loopback. So the truncation window is reasoned, not
    // observed, and this test only pins that a large slow-read body arrives whole.
    // If someone reintroduces the 'end' listener, this will NOT catch them.
    const body = 'x'.repeat(512 * 1024);
    const payload = `HTTP/1.1 200 OK\r\nContent-Length: ${String(body.length)}\r\n\r\n${body}`;
    const open: OpenNetnsChannel = () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      stdin.on('data', () => {
        stdout.write(payload);
        // The in-container server closed the connection: stdout EOF.
        stdout.end();
      });
      return { stdin, stdout, stderr: new PassThrough(), close: () => stdout.destroy() };
    };
    const port = await freePort();
    const proxy = await startNetnsProxy({ host: '127.0.0.1', port, containerId: 'c1', open });

    try {
      const received = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.write('GET / HTTP/1.1\r\n\r\n');
          // A SLOW reader is what makes this a real guard rather than a happy
          // path: the response backs up in the socket's buffer, so a
          // `destroy()` racing the graceful `end()` discards the tail. Reading
          // eagerly on loopback hides the window entirely.
          socket.pause();
          setTimeout(() => socket.resume(), 150);
        });
        socket.on('data', (c: Buffer) => chunks.push(c));
        socket.on('close', () => resolve(Buffer.concat(chunks).toString()));
        socket.once('error', reject);
      });
      expect(received.length).toBe(payload.length);
      expect(received.endsWith('x'.repeat(64))).toBe(true);
    } finally {
      await proxy.close();
    }
  });

  it('REFUSES past the relay ceiling instead of accepting a connection that hangs', async () => {
    // Over the container's pids limit `docker exec` cannot fork, and an accepted
    // socket that never answers reads as model latency — the false red this
    // harness exists to remove. A reset is the honest signal.
    const opened: number[] = [];
    const open: OpenNetnsChannel = () => {
      opened.push(1);
      return {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        close: () => {},
      };
    };
    const port = await freePort();
    const proxy = await startNetnsProxy({
      host: '127.0.0.1',
      port,
      containerId: 'c1',
      open,
      maxConcurrent: 2,
    });

    /** Connect and hold; resolve 'open' or 'refused'. */
    const hold = (): Promise<{ outcome: string; socket: net.Socket }> =>
      new Promise((resolve) => {
        const socket = net.connect(port, '127.0.0.1');
        socket.once('connect', () => setTimeout(() => resolve({ outcome: 'open', socket }), 60));
        socket.once('close', () => resolve({ outcome: 'refused', socket }));
        socket.once('error', () => {});
      });

    try {
      const held = [await hold(), await hold()];
      expect(held.map((h) => h.outcome)).toEqual(['open', 'open']);
      // The third is over the ceiling: refused promptly, not left hanging.
      const third = await hold();
      expect(third.outcome).toBe('refused');
      expect(opened).toHaveLength(2);
      for (const h of held) h.socket.destroy();
    } finally {
      await proxy.close();
    }
  });

  it('rejects rather than silently not listening when the port is taken', async () => {
    const port = await freePort();
    const squatter = net.createServer();
    await new Promise<void>((resolve) => squatter.listen(port, '127.0.0.1', () => resolve()));
    try {
      const { open } = echoChannel('ok');
      await expect(
        startNetnsProxy({ host: '127.0.0.1', port, containerId: 'c1', open })
      ).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });
});

describe('relayCeilingFor — the proxy and the container share one pids budget', () => {
  it('derives the ceiling from the container limit, reserving room for the workload', () => {
    expect(relayCeilingFor(512)).toBe(
      Math.floor((512 - PIDS_RESERVED_FOR_WORKLOAD) / PIDS_PER_RELAY)
    );
    // Raising --pids-limit raises the relay ceiling with it: the two constants
    // cannot drift, which is the whole reason this is derived and not hardcoded.
    expect(relayCeilingFor(1024)).toBeGreaterThan(relayCeilingFor(512));
  });

  it('never returns zero, even with a pids limit below the reservation', () => {
    expect(relayCeilingFor(16)).toBe(1);
    expect(relayCeilingFor(PIDS_RESERVED_FOR_WORKLOAD)).toBe(1);
  });

  it('stays well under the ~64 relays at which forking actually failed', () => {
    // Measured: 50 concurrent relays peaked at 416 pids; 80 blew the 512 limit and
    // 17 connections hung for 60s. The ceiling must sit below that cliff.
    expect(relayCeilingFor(512)).toBeLessThan(64);
    // ...and above the handful a drive loop needs (POST + SSE + health polls).
    expect(relayCeilingFor(512)).toBeGreaterThanOrEqual(8);
  });
});
