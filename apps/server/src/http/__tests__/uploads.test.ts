/**
 * `parseUploads` (`http/uploads.ts`) on its own: what it stores, in which
 * order, and what it leaves behind when it refuses a body. The routes' wire
 * answers are pinned by `contract/file-groups.contract.test.ts`; this file
 * pins what the contract cannot see from outside, the files on disk.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getRequestListener, type HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { parseUploads, UploadLimitError, type ParseUploadsOptions } from '../uploads.js';

let dir: string;
let options: ParseUploadsOptions;

const app = new Hono<{ Bindings: HttpBindings }>();
app.post('/upload', async (c) => {
  try {
    const files = await parseUploads(c, options);
    return c.json({
      files: files.map((file) => ({
        name: file.originalname,
        size: file.size,
        stored: file.filename ?? file.buffer?.toString('utf8'),
      })),
    });
  } catch (err) {
    const code = err instanceof UploadLimitError ? err.code : undefined;
    return c.json({ error: (err as Error).message, code }, 400);
  }
});
const server = listeningServer(getRequestListener(app.fetch, { overrideGlobalObjects: false }));

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dorkos-uploads-'));
  options = {
    field: 'files',
    maxCount: 3,
    limits: { fileSize: 8, files: 3 },
    disk: { directory: path.join(dir, 'nested'), filename: (name) => `saved-${name}` },
  };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('parseUploads', () => {
  it('stores files on disk in the order they arrived, creating the folder', async () => {
    const res = await request(server)
      .post('/upload')
      .attach('files', Buffer.from('one'), 'a.txt')
      .attach('files', Buffer.from('eightBB!'), 'b.txt');

    expect(res.status).toBe(200);
    expect(res.body.files).toEqual([
      { name: 'a.txt', size: 3, stored: 'saved-a.txt' },
      { name: 'b.txt', size: 8, stored: 'saved-b.txt' },
    ]);
    expect((await readdir(path.join(dir, 'nested'))).sort()).toEqual([
      'saved-a.txt',
      'saved-b.txt',
    ]);
  });

  it('keeps files in memory without a folder', async () => {
    options = { field: 'files' };
    const res = await request(server).post('/upload').attach('files', Buffer.from('mem'), 'm.txt');

    expect(res.body.files).toEqual([{ name: 'm.txt', size: 3, stored: 'mem' }]);
  });

  it('removes the files it already wrote when a later one is over the limit', async () => {
    const res = await request(server)
      .post('/upload')
      .attach('files', Buffer.from('fine'), 'a.txt')
      .attach('files', Buffer.from('nine bytes'), 'b.txt');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'File too large', code: 'LIMIT_FILE_SIZE' });
    expect(await readdir(path.join(dir, 'nested'))).toEqual([]);
  });

  it('refuses a file past the field’s count, and removes the ones before it', async () => {
    options = { ...options, maxCount: 1, limits: { fileSize: 8 } };
    const res = await request(server)
      .post('/upload')
      .attach('files', Buffer.from('a'), 'a.txt')
      .attach('files', Buffer.from('b'), 'b.txt');

    expect(res.body).toEqual({ error: 'Unexpected file field', code: 'LIMIT_UNEXPECTED_FILE' });
    expect(await readdir(path.join(dir, 'nested'))).toEqual([]);
  });

  it('refuses the whole body when the filter refuses one file', async () => {
    options = {
      ...options,
      filter: (file) => (file.mimetype === 'image/png' ? new Error('no png') : undefined),
    };
    const res = await request(server)
      .post('/upload')
      .attach('files', Buffer.from('a'), { filename: 'a.txt', contentType: 'text/plain' })
      .attach('files', Buffer.from('b'), { filename: 'b.png', contentType: 'image/png' });

    expect(res.body).toEqual({ error: 'no png' });
    expect(await readdir(path.join(dir, 'nested'))).toEqual([]);
  });

  it('reads no files, and no error, from a body that is not multipart', async () => {
    const res = await request(server)
      .post('/upload')
      .send({ files: ['a.txt'] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ files: [] });
  });
});
