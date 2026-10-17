/**
 * `sendFileFromRoot` on a plain folder: the answers `res.sendFile` gave, and
 * every refusal `send` makes after its `headers` step reaching the route.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getRequestListener, type HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';
import { sendFileFromRoot } from '../send-file.js';

// Under a dot folder, as every upload is (`<cwd>/.dork/.temp/uploads`).
const root = path.join(mkdtempSync(path.join(tmpdir(), 'send-file-root-')), '.dork', 'files');
let server: Server;
let base = '';

beforeAll(async () => {
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'hello.txt'), 'hello');
  writeFileSync(path.join(root, '.secret'), 'hidden');
  mkdirSync(path.join(root, 'folder'));
  const app = new Hono<{ Bindings: HttpBindings }>();
  app.on(['GET', 'HEAD'], '/files/:name', async (c) => {
    const result = await sendFileFromRoot(c, root, c.req.param('name'));
    if (result.kind === 'sent') return result.response;
    if (result.kind === 'outside') return c.json({ refused: 'outside' }, 403);
    return c.json(
      { refused: result.error.code ?? 'send' },
      (result.error.status ?? 500) as 404 | 412 | 416 | 500
    );
  });
  server = createServer(getRequestListener(app.fetch, { overrideGlobalObjects: false }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(path.dirname(path.dirname(root)), { recursive: true, force: true });
});

/** A request that must answer within a second, never hang. */
function get(name: string, init: RequestInit = {}) {
  return fetch(`${base}/files/${name}`, { ...init, signal: AbortSignal.timeout(1_000) });
}

describe('sendFileFromRoot', () => {
  it('sends the file with its length and validators', async () => {
    const res = await get('hello.txt');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
    expect(res.headers.get('content-length')).toBe('5');
    expect(res.headers.get('etag')).toBeTruthy();
  });

  it('still refuses a name that is itself a dotfile', async () => {
    const res = await get('.secret');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('hidden');
  });

  it('answers a HEAD with the headers and no body', async () => {
    const res = await get('hello.txt', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('5');
    expect(await res.text()).toBe('');
  });

  it('sends a range inside the file as a 206', async () => {
    const res = await get('hello.txt', { headers: { Range: 'bytes=1-2' } });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('el');
  });

  it('hands a range past the end to the route, without the file headers', async () => {
    const res = await get('hello.txt', { headers: { Range: 'bytes=999-' } });
    expect(res.status).toBe(416);
    expect(await res.json()).toEqual({ refused: 'send' });
    expect(res.headers.get('etag')).toBeNull();
  });

  it('hands a failed precondition to the route', async () => {
    const res = await get('hello.txt', { headers: { 'If-Match': '"not-this-one"' } });
    expect(res.status).toBe(412);
    expect(await res.json()).toEqual({ refused: 'send' });
  });

  it('hands a missing file and a folder to the route', async () => {
    expect((await get('missing.txt')).status).toBe(404);
    const folder = await get('folder');
    expect(folder.status).toBe(500);
    expect(await folder.json()).toEqual({ refused: 'EISDIR' });
  });

  it('refuses a name that resolves outside the folder before reading anything', async () => {
    const res = await get(encodeURIComponent('../outside.txt'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ refused: 'outside' });
  });
});
