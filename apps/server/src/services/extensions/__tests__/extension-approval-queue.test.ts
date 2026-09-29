/**
 * An installed extension waiting for a person to let it run asks in the
 * Activity inbox (DOR-2517, spec `flow-multiproject` §5.6 items 1-5).
 *
 * Real discovery over a temp DorkOS home, a real `ExtensionManager`, the real
 * routes and a real notification store; only the esbuild compile and the
 * server-half lifecycle are stubbed, because neither is what is under test and
 * both are slow. "Installing a plugin" is done the way the marketplace
 * installer leaves it: the plugin's files under `{dorkHome}/plugins/<name>`,
 * its install sidecar beside them, then `enable(id)` (`flows/install-plugin.ts`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

/** The stored config the mocked config manager reports. */
const state = vi.hoisted(() => ({
  extensions: {
    enabled: [] as string[],
    disabled: [] as string[],
    approvedToRun: [] as string[],
    approvedSources: {} as Record<string, { path: string; plugin?: string }>,
    dismissedApprovals: {} as Record<string, unknown>,
  },
}));

vi.mock('../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'auth' ? { enabled: false } : state.extensions),
    set: (key: string, value: unknown) => {
      if (key === 'extensions') state.extensions = value as typeof state.extensions;
    },
  },
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../extension-compiler.js', () => ({
  ExtensionCompiler: vi.fn().mockImplementation(function () {
    return {
      compile: vi
        .fn()
        .mockResolvedValue({ code: 'export function activate() {}', sourceHash: 'h' }),
      readBundle: vi.fn().mockResolvedValue('export function activate() {}'),
      cleanStaleCache: vi.fn().mockResolvedValue(0),
    };
  }),
}));

vi.mock('../extension-server-lifecycle.js', () => ({
  ExtensionServerLifecycle: vi.fn().mockImplementation(function () {
    return {
      initialize: vi.fn().mockResolvedValue({ ok: true }),
      shutdown: vi.fn().mockResolvedValue(undefined),
      getRouter: vi.fn().mockReturnValue(null),
    };
  }),
}));

import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { eventFanOut } from '../../core/event-fan-out.js';
import { NotificationStore } from '../../notifications/notification-store.js';
import {
  NotificationService,
  setNotificationService,
} from '../../notifications/notification-service.js';
import { ExtensionManager } from '../extension-manager.js';
import {
  APPROVAL_WHY_MAX_LENGTH,
  startExtensionApprovalQueue,
  type ExtensionApprovalQueue,
} from '../extension-approval-queue.js';
import { createExtensionsRouter } from '../../../routes/extensions.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_FIXTURE = path.resolve(HERE, '../../marketplace/fixtures/valid-plugin');
const EXT_ID = 'sample-ext';

const target = swappableServer();
const server = target.server;

let dorkHome: string;
let manager: ExtensionManager;
let queue: ExtensionApprovalQueue;
let stopQueue: () => void;
let service: NotificationService;
let sent: Array<[string, unknown]>;

/** Every broadcast of one event name so far. */
function broadcasts(name: string): Array<Record<string, unknown>> {
  return sent
    .filter(([event]) => event === name)
    .map(([, data]) => data as Record<string, unknown>);
}

/** The `standing_pending` arrivals of `extension.approval` so far. */
function approvalArrivals(): Array<Record<string, unknown>> {
  return broadcasts('standing_pending').filter((event) => event.kind === 'extension.approval');
}

/** The stored `extension.approval` history rows. */
function historyRows() {
  return service
    .list({ limit: 50, unread: false })
    .notifications.filter((row) => row.kind === 'extension.approval');
}

/** Where a plugin's copy of the sample extension lives. */
function extensionDir(plugin: string): string {
  return path.join(dorkHome, 'plugins', plugin, '.dork', 'extensions', EXT_ID);
}

/** Rewrite the carried extension's manifest. */
function writeManifest(plugin: string, fields: Record<string, unknown>): void {
  const file = path.join(extensionDir(plugin), 'extension.json');
  const current = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
  fs.writeFileSync(file, JSON.stringify({ ...current, ...fields }, null, 2));
}

/**
 * Put the plugin fixture where the marketplace installer puts a plugin, with
 * its install sidecar, then turn its extension on exactly as the installer does.
 */
async function installPlugin(
  plugin = 'flow',
  manifest: Record<string, unknown> = { name: 'Flow', contributions: { 'right-panel': true } }
): Promise<void> {
  const root = path.join(dorkHome, 'plugins', plugin);
  fs.cpSync(PLUGIN_FIXTURE, root, { recursive: true });
  fs.writeFileSync(
    path.join(root, '.dork', 'install-metadata.json'),
    JSON.stringify({
      name: plugin,
      version: '1.0.0',
      type: 'plugin',
      installedAt: '2026-09-28T00:00:00.000Z',
      sourceRepo: 'dork-labs/marketplace',
    })
  );
  writeManifest(plugin, manifest);
  await manager.enable(EXT_ID);
  await queue.sync();
}

/** Ask the route what is waiting. */
async function pending() {
  const res = await request(server).get('/api/extensions/pending-approvals');
  expect(res.status).toBe(200);
  return res.body.approvals as Array<Record<string, unknown>>;
}

beforeEach(async () => {
  dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dork-ext-approval-'));
  state.extensions = {
    enabled: [],
    disabled: [],
    approvedToRun: [],
    approvedSources: {},
    dismissedApprovals: {},
  };
  sent = [];
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation((name, data) => {
    sent.push([name, data]);
  });
  service = new NotificationService(new NotificationStore(createTestDb()));
  setNotificationService(service);

  manager = new ExtensionManager(dorkHome);
  await manager.initialize(null);
  ({ queue, stop: stopQueue } = startExtensionApprovalQueue(manager));
  await queue.sync();

  const app = express();
  app.use(express.json());
  app.use(
    '/api/extensions',
    createExtensionsRouter(manager, dorkHome, () => null)
  );
  target.mount(app);
});

afterEach(() => {
  stopQueue();
  setNotificationService(null);
  vi.restoreAllMocks();
  fs.rmSync(dorkHome, { recursive: true, force: true });
});

describe('an extension waiting to run asks in the inbox', () => {
  it('1. installing a plugin that carries one produces exactly one item and one arrival', async () => {
    expect(await pending()).toEqual([]);

    await installPlugin();

    const approvals = await pending();
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      id: EXT_ID,
      name: 'Flow',
      version: '1.0.0',
      plugin: 'flow',
      path: extensionDir('flow'),
      sourceLabel: 'flow plugin · dork-labs/marketplace',
      adds: 'It adds a Flow tab',
      why: 'You installed the flow plugin. This adds a Flow tab. It runs as you.',
      runsInServer: false,
    });
    expect(approvalArrivals()).toHaveLength(1);
    expect(approvalArrivals()[0]).toMatchObject({
      title: 'Turn on Flow?',
      tier: 'notable',
      deepLink: '/?settings=extensions',
    });
  });

  it('2. allowing it from there lets it run, empties the queue, and records one answer', async () => {
    await installPlugin();

    const res = await request(server).post(`/api/extensions/${EXT_ID}/approve`).send({});
    expect(res.status).toBe(200);
    await queue.sync();

    expect(manager.listPublic().find((ext) => ext.id === EXT_ID)?.approvedToRun).toBe(true);
    expect(await pending()).toEqual([]);
    const rows = historyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: 'approved',
      title: 'You turned on Flow',
      body: 'Flow tab added',
      subject: { type: 'system', id: `${EXT_ID}@1.0.0` },
    });
    // The person answered it themselves, so it is not news to them.
    expect(rows[0].readAt).toBeDefined();
    expect(broadcasts('extension_reloaded')).toEqual([
      expect.objectContaining({ extensionIds: [EXT_ID] }),
    ]);
    // Its arrival is retired everywhere it was drawn.
    expect(broadcasts('standing_resolved')).toEqual([
      expect.objectContaining({ kind: 'extension.approval' }),
    ]);
  });

  it('3. an update from the same approved source asks nothing new', async () => {
    await installPlugin();
    await request(server).post(`/api/extensions/${EXT_ID}/approve`).send({});
    await queue.sync();
    const arrivalsBefore = approvalArrivals().length;

    writeManifest('flow', { version: '1.1.0' });
    await manager.reload();
    await queue.sync();

    expect(manager.get(EXT_ID)?.manifest.version).toBe('1.1.0');
    expect(await pending()).toEqual([]);
    expect(approvalArrivals()).toHaveLength(arrivalsBefore);
  });

  it('4. the same extension arriving from another source asks again', async () => {
    await installPlugin();
    await request(server).post(`/api/extensions/${EXT_ID}/approve`).send({});
    await queue.sync();

    fs.renameSync(path.join(dorkHome, 'plugins', 'flow'), path.join(dorkHome, 'plugins', 'fork'));
    await manager.reload();
    await queue.sync();

    const approvals = await pending();
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ id: EXT_ID, plugin: 'fork', path: extensionDir('fork') });
  });

  describe('5. "Not now"', () => {
    it('empties the queue, records the answer, and removes and disables nothing', async () => {
      await installPlugin();
      const [shown] = await pending();

      const res = await request(server)
        .post(`/api/extensions/${EXT_ID}/dismiss-approval`)
        .send({ path: shown.path, version: shown.version });
      expect(res.status).toBe(204);
      await queue.sync();

      expect(await pending()).toEqual([]);
      const rows = historyRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ outcome: 'dismissed', title: 'Flow is off for now' });
      // Never destructive: still installed, still turned on, still not allowed.
      expect(fs.existsSync(extensionDir('flow'))).toBe(true);
      expect(state.extensions.enabled).toContain(EXT_ID);
      expect(manager.get(EXT_ID)?.status).not.toBe('disabled');
      expect(state.extensions.approvedToRun).not.toContain(EXT_ID);
    });

    it('asks again when the version changes', async () => {
      await installPlugin();
      const [shown] = await pending();
      await request(server)
        .post(`/api/extensions/${EXT_ID}/dismiss-approval`)
        .send({ path: shown.path, version: shown.version });
      await queue.sync();
      expect(await pending()).toEqual([]);

      writeManifest('flow', { version: '1.1.0' });
      await manager.reload();
      await queue.sync();

      const approvals = await pending();
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({ version: '1.1.0' });
    });

    it('refuses an answer to a row that is out of date, and writes nothing', async () => {
      await installPlugin();
      writeManifest('flow', { version: '1.1.0' });
      await manager.reload();
      await queue.sync();

      const res = await request(server)
        .post(`/api/extensions/${EXT_ID}/dismiss-approval`)
        .send({ path: extensionDir('flow'), version: '1.0.0' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('stale_approval');
      expect(state.extensions.dismissedApprovals).toEqual({});
      expect(await pending()).toHaveLength(1);
    });

    it('refuses an agent that names itself, and writes nothing', async () => {
      await installPlugin();
      const [shown] = await pending();

      const res = await request(server)
        .post(`/api/extensions/${EXT_ID}/dismiss-approval`)
        .set('x-dorkos-agent', 'agent-token-abc')
        .send({ path: shown.path, version: shown.version });

      expect(res.status).toBe(403);
      expect(state.extensions.dismissedApprovals).toEqual({});
    });

    it('answers 404 for an extension that is not there', async () => {
      const res = await request(server)
        .post('/api/extensions/nope/dismiss-approval')
        .send({ path: '/x', version: '1.0.0' });
      expect(res.status).toBe(404);
    });

    it('is cleared by a later approval, so a withdrawal plus a reinstall asks again', async () => {
      await installPlugin();
      const [shown] = await pending();
      await request(server)
        .post(`/api/extensions/${EXT_ID}/dismiss-approval`)
        .send({ path: shown.path, version: shown.version });

      await request(server).post(`/api/extensions/${EXT_ID}/approve`).send({});
      expect(state.extensions.dismissedApprovals).toEqual({});

      await request(server).post(`/api/extensions/${EXT_ID}/revoke`).send({});
      await queue.sync();
      expect(await pending()).toHaveLength(1);
    });
  });

  it('writes no history row for a copy that simply went away', async () => {
    await installPlugin();

    fs.rmSync(path.join(dorkHome, 'plugins', 'flow'), { recursive: true, force: true });
    await manager.reload();
    await queue.sync();

    expect(await pending()).toEqual([]);
    expect(historyRows()).toEqual([]);
    expect(broadcasts('standing_resolved')).toHaveLength(1);
  });

  it('never asks about an extension someone turned off', async () => {
    await installPlugin();
    await manager.disable(EXT_ID);
    await queue.sync();

    expect(await pending()).toEqual([]);
  });

  it('keeps one row per copy across repeated re-scans', async () => {
    await installPlugin();
    await manager.reload();
    await manager.reload();
    await queue.sync();

    expect(approvalArrivals()).toHaveLength(1);
  });
});

describe('the why line', () => {
  it('uses the purpose after what it adds', async () => {
    await installPlugin('flow', {
      name: 'Flow',
      contributions: { 'right-panel': true, 'settings.tabs': true },
      purpose: 'shows what your agents are working on',
    });

    const [approval] = await pending();
    expect(approval.adds).toBe('It adds a Flow tab and a Flow settings page');
    expect(approval.why).toBe(
      'You installed the flow plugin. This adds a Flow tab and a Flow settings page that ' +
        'shows what your agents are working on. It runs as you.'
    );
  });

  it('falls back to the description when the manifest does not say what it adds', async () => {
    await installPlugin('flow', { name: 'Flow', description: 'Tracks your work items' });

    const [approval] = await pending();
    expect(approval.adds).toBeNull();
    expect(approval.why).toBe(
      'You installed the flow plugin. Tracks your work items. It runs as you.'
    );
  });

  it('says only who installed it and that it runs as you when there is nothing else', async () => {
    await installPlugin('flow', { name: 'Flow' });

    const [approval] = await pending();
    expect(approval.why).toBe('You installed the flow plugin. It runs as you.');
  });

  it('names the extension itself for a direct install', async () => {
    const dir = path.join(dorkHome, 'extensions', 'solo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'extension.json'),
      JSON.stringify({ id: 'solo', name: 'Solo', version: '2.0.0' })
    );
    fs.writeFileSync(path.join(dir, 'index.ts'), 'export function activate() {}\n');
    await manager.enable('solo');
    await queue.sync();

    const [approval] = await pending();
    expect(approval).toMatchObject({ id: 'solo', plugin: null });
    expect(approval.why).toBe('You installed Solo. It runs as you.');
    expect(approval.sourceLabel).toMatch(/^installed in /);
  });

  it('is cut at 300 characters, whatever the manifest says', async () => {
    await installPlugin('flow', { name: 'Flow', description: 'x'.repeat(400) });

    const [approval] = await pending();
    expect((approval.why as string).length).toBe(APPROVAL_WHY_MAX_LENGTH);
    expect(approval.why).toMatch(/…$/);
  });
});
