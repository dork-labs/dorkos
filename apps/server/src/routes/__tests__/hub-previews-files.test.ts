/**
 * @vitest-environment node
 *
 * On a hub (DOR-2937), nothing a person's files or dev servers hold opens as a
 * page at the hub's own address: the embedded browser is offered no preview,
 * a serve token is refused, and only pictures, sound and video are shown in
 * the page while every other file downloads. On a person's own computer each
 * of these stays exactly as it was.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';

const role = vi.hoisted(() => ({ value: 'computer' as 'computer' | 'hub' }));
vi.mock('../../lib/server-role.js', () => ({ currentServerRole: () => role.value }));
// The front door and the sign-in are not what this file is about.
vi.mock('../../services/core/hub/hub-serving.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/hub/hub-serving.js')>()),
  admitHubRequest: () => null,
  trackHubConnection: () => {},
}));
vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/core/auth/session-gate.js')>();
  return {
    ...actual,
    decideSessionGate: async () => ({
      allowed: true,
      user: { userId: 'owner', credential: 'cookie' },
    }),
  };
});
vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: () => undefined, set: () => {}, onChange: () => () => {} },
}));

import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { initBoundary } from '../../lib/boundary.js';
import { workbenchTokenSigner } from '../../services/workbench-serve/index.js';
import workbenchRoutes from '../workbench-serve.js';
import { createFileRoutes } from '../files.js';
import uploadRoutes from '../uploads.js';
import { servesInlineHere } from '../../lib/file-route-guards.js';

const server = listeningServer(
  honoGroupListener([
    { path: '/api/workbench', routes: workbenchRoutes },
    { path: '/api/files', routes: createFileRoutes() },
    { path: '/api/uploads', routes: uploadRoutes },
  ])
);

let root: string;

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hub-previews-')));
  await fs.writeFile(path.join(root, 'index.html'), '<h1>hi</h1>');
  await fs.writeFile(path.join(root, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fs.writeFile(path.join(root, 'clip.mp4'), 'video');
  await fs.writeFile(path.join(root, 'drawing.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await fs.writeFile(path.join(root, 'report.pdf'), '%PDF-1.7');
  await fs.writeFile(path.join(root, 'model.glb'), 'glb');
  const uploads = path.join(root, '.dork', '.temp', 'uploads');
  await fs.mkdir(uploads, { recursive: true });
  await fs.writeFile(path.join(uploads, 'notes.html'), '<script>alert(1)</script>');
  await fs.writeFile(
    path.join(uploads, 'drawing.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"/>'
  );
  await fs.writeFile(path.join(uploads, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await initBoundary(root);
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  role.value = 'hub';
});

const raw = (file: string) =>
  request(server).get(
    `/api/files/raw?cwd=${encodeURIComponent(root)}&path=${encodeURIComponent(file)}`
  );

describe('previews on a hub', () => {
  it('offers no local file preview', async () => {
    const res = await request(server)
      .post('/api/workbench/sign')
      .send({ kind: 'serve', cwd: root });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: null });
  });

  it('offers no dev server preview, as a tunnel would not', async () => {
    const res = await request(server)
      .post('/api/workbench/sign')
      .send({ kind: 'proxy', port: 5173 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: null, unavailable: 'tunnel' });
  });

  it('does not say which of its own ports are in use', async () => {
    const res = await request(server).post('/api/workbench/probe').send({ port: 5173 });
    expect(res.status).toBe(409);
    expect(res.body.listening).toBeUndefined();
  });

  it('refuses a serve token, even a good one', async () => {
    const token = workbenchTokenSigner.mint({ kind: 'serve', cwd: root });
    const res = await request(server).get(`/api/workbench/serve/${token}/index.html`);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('<h1>hi</h1>');
  });

  it('still previews local files on a person’s own computer', async () => {
    role.value = 'computer';
    const res = await request(server)
      .post('/api/workbench/sign')
      .send({ kind: 'serve', cwd: root });
    expect(res.body.url).toContain('/api/workbench/serve/');
    const served = await request(server).get(res.body.url.slice(res.body.url.indexOf('/api/')));
    expect(served.status).toBe(200);
  });
});

describe('files on a hub', () => {
  it.each(['photo.png', 'clip.mp4'])('shows %s in the page', async (file) => {
    const res = await raw(file);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('inline');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it.each(['drawing.svg', 'report.pdf', 'model.glb'])('downloads %s', async (file) => {
    const res = await raw(file);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('shows every type in the page on a person’s own computer', async () => {
    role.value = 'computer';
    for (const file of ['drawing.svg', 'report.pdf', 'model.glb']) {
      expect((await raw(file)).headers['content-disposition']).toBe('inline');
    }
  });
});

const upload = (file: string) =>
  request(server).get(`/api/uploads/${file}?cwd=${encodeURIComponent(root)}`);

describe('uploads', () => {
  it.each(['notes.html', 'drawing.svg'])('sends %s as opaque bytes to download', async (file) => {
    const res = await upload(file);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toBe('attachment');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('sandbox');
  });

  it('shows a picture in the page', async () => {
    const res = await upload('photo.png');
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toBeUndefined();
  });

  it('answers a missing upload as JSON, not as a download', async () => {
    const res = await upload('missing.html');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('downloads one that could open as a page on a person’s own computer too', async () => {
    role.value = 'computer';
    const res = await upload('notes.html');
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toBe('attachment');
    expect((await upload('photo.png')).headers['content-type']).toBe('image/png');
  });
});

describe('which files show in the page', () => {
  it('on a hub: pictures, sound and video only', () => {
    expect(servesInlineHere('image/png')).toBe(true);
    expect(servesInlineHere('audio/mpeg')).toBe(true);
    expect(servesInlineHere('video/mp4')).toBe(true);
    for (const type of ['image/svg+xml', 'application/pdf', 'model/gltf-binary', 'text/html']) {
      expect(servesInlineHere(type)).toBe(false);
    }
  });

  it('on a person’s own computer: every type', () => {
    role.value = 'computer';
    expect(servesInlineHere('application/pdf')).toBe(true);
  });
});
