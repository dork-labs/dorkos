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
import {
  parseUploadForm,
  parseUploads,
  UploadLimitError,
  type ParseUploadsOptions,
} from '../uploads.js';

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
app.post('/form', async (c) => {
  try {
    const form = await parseUploadForm(c, options);
    if (!form) return c.json({ multipart: false });
    return c.json({
      fields: form.fields,
      names: form.files.map((file) => file.originalname),
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

  it('removes the files it already wrote when a later one is over the limit', async () => {
    const res = await request(server)
      .post('/upload')
      .attach('files', Buffer.from('fine'), 'a.txt')
      .attach('files', Buffer.from('nine bytes'), 'b.txt');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'File too large', code: 'LIMIT_FILE_SIZE' });
    expect(await readdir(path.join(dir, 'nested'))).toEqual([]);
  });

  it('takes files in each of several fields, up to each field’s own count', async () => {
    options = {
      fields: [
        { name: 'clip', maxCount: 1 },
        { name: 'frame', maxCount: 1 },
      ],
      disk: options.disk,
    };
    const res = await request(server)
      .post('/upload')
      .attach('frame', Buffer.from('f'), 'f.png')
      .attach('clip', Buffer.from('c'), 'c.gif');

    expect(res.status).toBe(200);
    expect(res.body.files).toEqual([
      { name: 'f.png', size: 1, stored: 'saved-f.png' },
      { name: 'c.gif', size: 1, stored: 'saved-c.gif' },
    ]);
  });

  it('refuses a second file in a field of one, and removes the first', async () => {
    options = {
      fields: [
        { name: 'clip', maxCount: 1 },
        { name: 'frame', maxCount: 1 },
      ],
      disk: options.disk,
    };
    const res = await request(server)
      .post('/upload')
      .attach('clip', Buffer.from('a'), 'a.gif')
      .attach('clip', Buffer.from('b'), 'b.gif');

    expect(res.body).toEqual({ error: 'Unexpected file field', code: 'LIMIT_UNEXPECTED_FILE' });
    expect(await readdir(path.join(dir, 'nested'))).toEqual([]);
  });
});

describe('parseUploadForm', () => {
  it('gathers the text fields as multer did: repeated names as a list, brackets nested', async () => {
    const res = await request(server)
      .post('/form')
      .field('dir', 'docs')
      .field('tag', 'a')
      .field('tag', 'b')
      .field('meta[owner]', 'ana')
      .field('list[]', 'x')
      .attach('files', Buffer.from('one'), 'a.txt');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      fields: { dir: 'docs', tag: ['a', 'b'], meta: { owner: 'ana' }, list: ['x'] },
      names: ['a.txt'],
    });
  });

  it('reads a filename with no declared charset as UTF-8 when asked', async () => {
    options = { ...options, paramCharset: 'utf8' };
    const res = await request(server).post('/form').attach('files', Buffer.from('r'), 'résumé.txt');

    expect(res.body.names).toEqual(['résumé.txt']);
  });

  it('refuses a body past the field limit, and removes what it wrote', async () => {
    options = { ...options, limits: { ...options.limits, fields: 1 } };
    const res = await request(server)
      .post('/form')
      .attach('files', Buffer.from('a'), 'a.txt')
      .field('one', '1')
      .field('two', '2');

    expect(res.body).toEqual({ error: 'Too many fields', code: 'LIMIT_FIELD_COUNT' });
    expect(await readdir(path.join(dir, 'nested'))).toEqual([]);
  });

  it('answers no form for a body that is not multipart', async () => {
    const res = await request(server).post('/form').send({ dir: 'docs' });

    expect(res.body).toEqual({ multipart: false });
  });
});
