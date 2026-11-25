/**
 * `streamToNodeResponse`: a route on the Hono chain writing its own response to
 * the Node socket, as the discovery scan does. Driven over a real port behind
 * the real `/api` chain, because what it promises is about the wire: the
 * chain's headers on the raw response, each write leaving at once, a departed
 * client noticed.
 */
import http, { type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono, type Context } from 'hono';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { ApiEnv } from '../api-chain.js';
import { streamToNodeResponse, type RawNodeStreamControl } from '../raw-node-stream.js';
import { honoGroupListener } from './hono-group-listener.js';

type Writer = (res: ServerResponse, control: RawNodeStreamControl) => Promise<void> | void;

let server: http.Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** Serve `POST /api/stream` behind the chain, written by `writer`. */
async function serve(writer: Writer): Promise<string> {
  const routes = new Hono<ApiEnv>();
  routes.post('/', (c) => streamToNodeResponse(c, writer));
  server = http.createServer(honoGroupListener({ path: '/api/stream', routes }));
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server!.once('listening', resolve));
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Open the stream; resolves with the response once its head arrives. */
function open(host: string, headers: Record<string, string> = {}) {
  let req!: http.ClientRequest;
  const response = new Promise<http.IncomingMessage>((resolve, reject) => {
    req = http.request(`http://${host}/api/stream`, { method: 'POST', headers }, resolve);
    req.on('error', reject);
    req.end();
  });
  return { req: () => req, response };
}

/** Everything the response carries, as text. */
async function bodyOf(res: http.IncomingMessage): Promise<string> {
  let text = '';
  res.setEncoding('utf8');
  for await (const chunk of res) text += chunk;
  return text;
}

const EVENT_HEAD = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' };

describe('streamToNodeResponse', () => {
  it('sends each write as it is made, not when the writer finishes', async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const host = await serve(async (res) => {
      res.writeHead(200, EVENT_HEAD);
      res.write('event: first\ndata: {}\n\n');
      // Holds the stream open until the client has the first event: a buffered
      // response would never deliver it, and this would never return.
      await released;
      res.write('event: last\ndata: {}\n\n');
      res.end();
    });

    const { response } = open(host);
    const res = await response;
    res.setEncoding('utf8');
    const first = await new Promise<string>((resolve) => res.once('data', resolve));
    expect(first).toBe('event: first\ndata: {}\n\n');
    release();
    expect(await bodyOf(res)).toBe('event: last\ndata: {}\n\n');
  });

  it('carries the chain’s CORS and nosniff headers onto the raw response', async () => {
    const host = await serve((res) => {
      res.writeHead(200, EVENT_HEAD);
      res.end('event: done\ndata: {}\n\n');
    });

    const { response } = open(host, { origin: `http://${host}` });
    const res = await response;
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['access-control-allow-origin']).toBe(`http://${host}`);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-length']).toBeUndefined();
    expect(await bodyOf(res)).toBe('event: done\ndata: {}\n\n');
  });

  it('aborts the signal when the client leaves, and the writer can stop', async () => {
    let finished!: (aborted: boolean) => void;
    const writerDone = new Promise<boolean>((resolve) => (finished = resolve));
    const host = await serve(async (res, { signal }) => {
      res.writeHead(200, EVENT_HEAD);
      res.write('event: first\ndata: {}\n\n');
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      finished(signal.aborted);
    });

    const { req, response } = open(host);
    const res = await response;
    await new Promise((resolve) => res.once('data', resolve));
    req().destroy();
    expect(await writerDone).toBe(true);
  });

  it('lets the chain answer an error thrown before anything was written', async () => {
    const host = await serve(() => {
      throw new Error('could not start');
    });

    const { response } = open(host);
    const res = await response;
    expect(res.statusCode).toBe(500);
    expect(res.headers['content-type']).toBe('application/problem+json');
    expect(JSON.parse(await bodyOf(res))).toMatchObject({ code: 'internal_error' });
  });

  it('closes the connection on an error thrown after the head went out', async () => {
    const host = await serve((res) => {
      res.writeHead(200, EVENT_HEAD);
      res.write('event: first\ndata: {}\n\n');
      throw new Error('broke mid-stream');
    });

    const { response } = open(host);
    const res = await response;
    expect(res.statusCode).toBe(200);
    const ended = await new Promise<string>((resolve) => {
      res.on('aborted', () => resolve('aborted'));
      res.on('error', () => resolve('error'));
      res.on('end', () => resolve(res.complete ? 'complete' : 'cut'));
      res.resume();
    });
    expect(ended).not.toBe('complete');
  });

  /** A request from this computer, all the bare context needs to stand in for one. */
  const THIS_COMPUTER = {
    headers: { host: 'localhost:4242' },
    socket: { remoteAddress: '127.0.0.1' },
  };

  it('aborts at once when the response was already gone', async () => {
    const outgoing = Object.assign(new (await import('node:events')).EventEmitter(), {
      destroyed: true,
      writableFinished: false,
    });
    const c = { env: { outgoing, incoming: THIS_COMPUTER }, var: {} } as unknown as Context<ApiEnv>;
    let aborted: boolean | undefined;
    await streamToNodeResponse(c, (_res, { signal }) => {
      aborted = signal.aborted;
    });
    expect(aborted).toBe(true);
  });
});
