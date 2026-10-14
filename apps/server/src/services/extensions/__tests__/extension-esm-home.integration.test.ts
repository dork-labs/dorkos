/**
 * A server half starts when the DorkOS data directory sits inside a package
 * that declares `"type": "module"` (DOR-2192): the real compile, the real
 * lifecycle, a real temp directory. A plain `require()` of the CommonJS
 * bundle there failed with "module is not defined in ES module scope"; the
 * bundle is now evaluated with an injected `require`
 * (`server-bundle/load-in-process.ts`), so where it sits on disk no longer
 * decides its module format.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionsConfig } from '../extension-enable-resolution.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const stored = vi.hoisted(() => ({ value: {} as ExtensionsConfig }));
vi.mock('../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'extensions' ? stored.value : undefined),
    set: (key: string, value: unknown) => {
      if (key === 'extensions') stored.value = value as ExtensionsConfig;
    },
  },
}));

import { ExtensionManager } from '../extension-manager.js';
import { createExtensionApiRoutes } from '../../../routes/extension-api.js';
import { honoGroupListener } from '../../../http/__tests__/hono-group-listener.js';

const ID = 'esm-home';

let root: string;
let manager: ExtensionManager | undefined;
let server: http.Server | undefined;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dor-2192-')));
  // The package the data directory sits in, as a project or an install can.
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
});

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(null)));
  await manager?.shutdownServer(ID);
  await fs.rm(root, { recursive: true, force: true });
});

describe('a server half under a "type": "module" package', () => {
  it('compiles, starts, and serves through the inlined hono and requirePerson()', async () => {
    const dorkHome = path.join(root, '.dork');
    const extDir = path.join(dorkHome, 'extensions', ID);
    await fs.mkdir(extDir, { recursive: true });
    await fs.writeFile(
      path.join(extDir, 'extension.json'),
      JSON.stringify({ id: ID, name: 'ESM Home', version: '1.0.0', serverCapabilities: {} })
    );
    await fs.writeFile(path.join(extDir, 'index.ts'), 'export function activate() {}\n');
    await fs.writeFile(
      path.join(extDir, 'server.ts'),
      [
        "import { Hono } from 'hono';",
        "import { requirePerson } from '@dorkos/extension-api/server';",
        'const app = new Hono();',
        "app.get('/ok', (c) => c.json({ ok: true }));",
        "app.put('/settings', requirePerson(), (c) => c.json({ saved: true }));",
        'export default app;',
      ].join('\n')
    );
    stored.value = {
      enabled: [ID],
      disabled: [],
      approvedToRun: [ID],
      approvedSources: { [ID]: { path: extDir } },
    };

    manager = new ExtensionManager(dorkHome, []);
    await manager.initialize(null);

    expect(await manager.initializeServer(ID)).toEqual({ ok: true });
    expect(manager.listPublic().find((r) => r.id === ID)?.serverError).toBeUndefined();
    const running = manager;
    server = http.createServer(
      honoGroupListener({
        path: '/api/ext',
        routes: createExtensionApiRoutes({
          getServerHandler: (id) => running.getServerHandler(id),
        }),
      })
    );
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ext/${ID}`;

    const ok = await fetch(`${base}/ok`);
    const refused = await fetch(`${base}/settings`, {
      method: 'PUT',
      headers: { 'x-dorkos-agent': 'agent-1' },
    });

    expect(await ok.json()).toEqual({ ok: true });
    expect(refused.status).toBe(403);
  });
});
