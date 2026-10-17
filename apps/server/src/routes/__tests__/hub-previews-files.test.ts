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

const server = listeningServer(
  honoGroupListener([
    { path: '/api/workbench', routes: workbenchRoutes },
    { path: '/api/files', routes: createFileRoutes() },
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
