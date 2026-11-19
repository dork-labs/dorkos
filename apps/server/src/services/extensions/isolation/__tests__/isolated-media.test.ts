/**
 * A video by ticket for an extension in its own process (DOR-4321): one real
 * HTTP request over the connection the host opens, carrying only the range
 * headers and a verdict that the caller is not a person (Security condition 1).
 *
 * The child is stood in for by a plain HTTP server on a loopback port; the
 * host's virtual connection by a TCP socket to it. What crosses the
 * connection is the real HTTP the child would read.
 */
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isolatedMediaFetch } from '../isolated-media.js';
import { PERSON_VERDICT_HEADER } from '../ipc-protocol.js';

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}
const seen: Seen[] = [];
let answer: (res: http.ServerResponse) => void;

const child = http.createServer((req, res) => {
  seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
  answer(res);
});
let port = 0;
beforeAll(async () => {
  await new Promise<void>((resolve) => child.listen(0, '127.0.0.1', resolve));
  port = (child.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => child.close(() => resolve())));

const sockets: net.Socket[] = [];
/** A host whose every connection reaches the stand-in child. */
const host = {
  openConnection: () => {
    const socket = net.connect(port, '127.0.0.1');
    sockets.push(socket);
    return { ok: true as const, socket: socket as never };
  },
};

beforeEach(() => {
  seen.length = 0;
  sockets.length = 0;
  answer = (res) => {
    res.writeHead(206, { 'Content-Type': 'video/webm', 'Content-Range': 'bytes 0-2/10' });
    res.end(Buffer.from([7, 8, 9]));
  };
});

describe('isolatedMediaFetch', () => {
  it('asks for the mount and the ticket’s path, and streams the reply back', async () => {
    const fetchVideo = isolatedMediaFetch('clips', host);
    const res = await fetchVideo('/v/intro.webm', new Headers({ range: 'bytes=0-2' }), 'GET');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-2/10');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from([7, 8, 9]));
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/api/ext/clips/v/intro.webm' });
  });

  it('sends a verdict that the caller is not a person, and only the range headers', async () => {
    const fetchVideo = isolatedMediaFetch('clips', host);
    const headers = new Headers({
      range: 'bytes=0-',
      'if-range': '"v1"',
      cookie: 'better-auth.session_token=secret',
      origin: 'http://localhost:4242',
      'x-dorkos-agent': 'agent-token',
    });
    await (await fetchVideo('/v.webm', headers, 'GET')).arrayBuffer();
    const sent = seen[0]!.headers;
    expect(JSON.parse(String(sent[PERSON_VERDICT_HEADER]))).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(sent.range).toBe('bytes=0-');
    expect(sent['if-range']).toBe('"v1"');
    expect(sent.cookie).toBeUndefined();
    expect(sent.origin).toBeUndefined();
    expect(sent['x-dorkos-agent']).toBeUndefined();
  });

  it('answers HEAD with no body', async () => {
    const fetchVideo = isolatedMediaFetch('clips', host);
    const res = await fetchVideo('/v.webm', new Headers(), 'HEAD');
    expect(seen[0]!.method).toBe('HEAD');
    expect(res.body).toBeNull();
  });

  it('closes the connection once the reply has been read', async () => {
    const fetchVideo = isolatedMediaFetch('clips', host);
    await (await fetchVideo('/v.webm', new Headers(), 'GET')).arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sockets[0]!.destroyed).toBe(true);
  });

  it('fails when the child does not answer in time', async () => {
    answer = () => undefined;
    const fetchVideo = isolatedMediaFetch('clips', host, 30);
    await expect(fetchVideo('/v.webm', new Headers(), 'GET')).rejects.toThrow();
    expect(sockets[0]!.destroyed).toBe(true);
  });

  it('fails when the child is not running', async () => {
    const stopped = {
      openConnection: () => ({ ok: false as const, reason: 'not_running' as const }),
    };
    await expect(
      isolatedMediaFetch('clips', stopped)('/v.webm', new Headers(), 'GET')
    ).rejects.toThrow();
  });
});
