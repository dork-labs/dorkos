/**
 * An app's screen data lives in its own file and can never touch the data its
 * server half keeps through `ctx.storage` (DOR-3293, Security item 7).
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import type { ExtensionRecord } from '@dorkos/extension-api';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { createExtensionsRoutes } from '../extensions.js';
import { PREFS_MAX_BYTES } from '../extensions-prefs.js';
import { initConfigManager } from '../../services/core/config-manager.js';

const target = swappableServer();
let dorkHome: string;

function record(id: string): ExtensionRecord {
  return {
    id,
    manifest: { id, name: id, version: '1.0.0', clientApiVersion: 2 },
    status: 'compiled',
    scope: 'global',
    origin: 'user',
    path: `/tmp/extensions/${id}`,
    bundleReady: true,
    hasServerEntry: true,
    hasDataProxy: false,
  } as ExtensionRecord;
}

beforeEach(async () => {
  dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-prefs-'));
  initConfigManager(dorkHome);
  const manager = {
    get: vi.fn((id: string) => (id === 'alpha' || id === 'beta' ? record(id) : undefined)),
    listPublic: vi.fn().mockReturnValue([]),
    listShadowedPublic: vi.fn().mockReturnValue([]),
  };
  target.mount(
    honoGroupListener({
      path: '/api/extensions',
      routes: createExtensionsRoutes({
        manager: manager as unknown as Parameters<typeof createExtensionsRoutes>[0]['manager'],
        dorkHome,
        getCwd: () => null,
      }),
    })
  );
});
afterEach(async () => {
  await fs.rm(dorkHome, { recursive: true, force: true });
});

const asAlpha = { 'X-DorkOS-Extension': 'alpha' };

describe('an app’s screen data', () => {
  it('never changes the server half’s ctx.storage file, byte for byte', async () => {
    const dataDir = path.join(dorkHome, 'extension-data', 'alpha');
    await fs.mkdir(dataDir, { recursive: true });
    const serverData = '{\n  "cursor": "server-only",\n  "token": "kept"\n}';
    await fs.writeFile(path.join(dataDir, 'data.json'), serverData);

    const res = await request(target.server)
      .put('/api/extensions/alpha/prefs')
      .set(asAlpha)
      .send({ cursor: 'from-the-screen', token: 'overwritten?' });
    expect(res.status).toBe(200);

    expect(await fs.readFile(path.join(dataDir, 'data.json'), 'utf-8')).toBe(serverData);
    expect(JSON.parse(await fs.readFile(path.join(dataDir, 'prefs.json'), 'utf-8'))).toEqual({
      cursor: 'from-the-screen',
      token: 'overwritten?',
    });
  });

  it('reads back only what the screens saved, never the server half’s data', async () => {
    const dataDir = path.join(dorkHome, 'extension-data', 'alpha');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'data.json'), '{"secretish":"server"}');
    expect((await request(target.server).get('/api/extensions/alpha/prefs')).status).toBe(204);
    await request(target.server).put('/api/extensions/alpha/prefs').set(asAlpha).send({ a: 1 });
    const res = await request(target.server).get('/api/extensions/alpha/prefs');
    expect(res.body).toEqual({ a: 1 });
  });

  it('refuses one app writing another app’s screen data, and writes nothing', async () => {
    const res = await request(target.server)
      .put('/api/extensions/beta/prefs')
      .set(asAlpha)
      .send({ taken: true });
    expect(res.status).toBe(403);
    await expect(
      fs.stat(path.join(dorkHome, 'extension-data', 'beta', 'prefs.json'))
    ).rejects.toThrow();
  });

  it('refuses screen data over the size cap, and writes nothing', async () => {
    const res = await request(target.server)
      .put('/api/extensions/alpha/prefs')
      .set(asAlpha)
      .send({ blob: 'x'.repeat(PREFS_MAX_BYTES) });
    expect(res.status).toBe(413);
    await expect(
      fs.stat(path.join(dorkHome, 'extension-data', 'alpha', 'prefs.json'))
    ).rejects.toThrow();
  });
});
