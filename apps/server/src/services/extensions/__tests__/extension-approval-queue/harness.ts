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
import { expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ExtensionApprovedSource } from '@dorkos/shared/config-schema';

/** The stored config the mocked config manager reports. */
const stateHoisted = vi.hoisted(() => ({
  extensions: {
    enabled: [] as string[],
    disabled: [] as string[],
    approvedToRun: [] as string[],
    approvedSources: {} as Record<string, ExtensionApprovedSource>,
    dismissedApprovals: {} as Record<string, unknown>,
  },
}));

vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) =>
      key === 'auth'
        ? { enabled: false }
        : key === 'runtimes'
          ? { defaultTrustStop: 'autonomy' }
          : stateHoisted.extensions,
    set: (key: string, value: unknown) => {
      if (key === 'extensions') stateHoisted.extensions = value as typeof stateHoisted.extensions;
    },
  },
}));

vi.mock('../../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../extension-compiler.js', () => ({
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

vi.mock('../../extension-server-lifecycle.js', () => ({
  ExtensionServerLifecycle: vi.fn().mockImplementation(function () {
    return {
      initialize: vi.fn().mockResolvedValue({ ok: true }),
      shutdown: vi.fn().mockResolvedValue(undefined),
      getHandler: vi.fn().mockReturnValue(null),
      toolStatuses: vi.fn().mockReturnValue(undefined),
      supervisedStatus: vi.fn().mockReturnValue({}),
      resetRestarts: vi.fn(),
    };
  }),
}));

import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { eventFanOut } from '../../../core/event-fan-out.js';
import { NotificationStore } from '../../../notifications/notification-store.js';
import {
  NotificationService,
  setNotificationService,
} from '../../../notifications/notification-service.js';
import { ExtensionManager } from '../../extension-manager.js';
import {
  startExtensionApprovalQueue,
  type ExtensionApprovalQueue,
} from '../../extension-approval-queue.js';
import { createExtensionsRoutes } from '../../../../routes/extensions.js';
import { extensionDoorRoutes } from '../../http-capabilities/__tests__/extension-doors-fixture.js';
import { honoGroupListener } from '../../../../http/__tests__/hono-group-listener.js';

/** The suites' own folder (one up from this harness), which fixture paths are relative to. */
export const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_FIXTURE = path.resolve(HERE, '../../marketplace/fixtures/valid-plugin');
export const EXT_ID = 'sample-ext';

const target = swappableServer();
export const server = target.server;

/** What each test runs against, rebuilt before every test. */
export const h = {
  dorkHome: '',
  manager: undefined as unknown as ExtensionManager,
  queue: undefined as unknown as ExtensionApprovalQueue,
  stopQueue: (() => undefined) as () => void,
  service: undefined as unknown as NotificationService,
  sent: [] as Array<[string, unknown]>,
};

/** Every broadcast of one event name so far. */
export function broadcasts(name: string): Array<Record<string, unknown>> {
  return h.sent
    .filter(([event]) => event === name)
    .map(([, data]) => data as Record<string, unknown>);
}

/** The `standing_pending` arrivals of `extension.approval` so far. */
export function approvalArrivals(): Array<Record<string, unknown>> {
  return broadcasts('standing_pending').filter((event) => event.kind === 'extension.approval');
}

/** The stored `extension.approval` history rows. */
export function historyRows() {
  return h.service
    .list({ limit: 50, unread: false })
    .notifications.filter((row) => row.kind === 'extension.approval');
}

/** Where a plugin's copy of the sample extension lives. */
export function extensionDir(plugin: string): string {
  return path.join(h.dorkHome, 'plugins', plugin, '.dork', 'extensions', EXT_ID);
}

/** Rewrite the carried extension's manifest. */
export function writeManifest(plugin: string, fields: Record<string, unknown>): void {
  const file = path.join(extensionDir(plugin), 'extension.json');
  const current = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
  fs.writeFileSync(file, JSON.stringify({ ...current, ...fields }, null, 2));
}

/**
 * Put the plugin fixture where the marketplace installer puts a plugin, with
 * its install sidecar, then turn its extension on exactly as the installer does.
 */
export async function installPlugin(
  plugin = 'flow',
  manifest: Record<string, unknown> = { name: 'Flow', contributions: { 'right-panel': true } },
  options: { throughInstaller: boolean } = { throughInstaller: true }
): Promise<void> {
  const root = path.join(h.dorkHome, 'plugins', plugin);
  fs.cpSync(PLUGIN_FIXTURE, root, { recursive: true });
  if (options.throughInstaller) {
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
  }
  writeManifest(plugin, manifest);
  await h.manager.enable(EXT_ID);
  await h.queue.sync();
}

/**
 * What a card for the copy on disk now would send: its version and the
 * digest of its files, which every yes but a dev link's names (DOR-3068).
 */
export function card(): { version: string; expectedDigest?: string } {
  const record = h.manager.listPublic().find((ext) => ext.id === EXT_ID)!;
  return {
    version: record.manifest.version,
    ...(record.digest ? { expectedDigest: record.digest } : {}),
  };
}

export async function pending() {
  const res = await request(server).get('/api/extensions/pending-approvals');
  expect(res.status).toBe(200);
  return res.body.approvals as Array<Record<string, unknown>>;
}

beforeEach(async () => {
  h.dorkHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dork-ext-approval-')));
  stateHoisted.extensions = {
    enabled: [],
    disabled: [],
    approvedToRun: [],
    approvedSources: {},
    dismissedApprovals: {},
  };
  h.sent = [];
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation((name, data) => {
    h.sent.push([name, data]);
  });
  h.service = new NotificationService(new NotificationStore(createTestDb()));
  setNotificationService(h.service);

  h.manager = new ExtensionManager(h.dorkHome);
  await h.manager.initialize(null);
  ({ queue: h.queue, stop: h.stopQueue } = startExtensionApprovalQueue(h.manager));
  await h.queue.sync();

  target.mount(
    honoGroupListener([
      {
        path: '/api/extensions',
        routes: createExtensionsRoutes({
          manager: h.manager,
          dorkHome: h.dorkHome,
          getCwd: () => null,
        }),
      },
      // "Not now" and the rest of the person's doors are on the capability mount (DOR-4978).
      { path: '/', routes: extensionDoorRoutes(h.manager) },
    ])
  );
});

afterEach(async () => {
  h.stopQueue();
  // A prior manager change can still be handling approvals. Wait before
  // another test replaces the shared notification service and event capture.
  await h.queue.sync({ announce: false });
  setNotificationService(null);
  vi.restoreAllMocks();
  fs.rmSync(h.dorkHome, { recursive: true, force: true });
});

/** Exported view of the hoisted `state` (vitest refuses to export a hoisted binding). */
export const state = stateHoisted;
