/**
 * Settings → Extensions for "Confirm it's you" (DOR-3234, Must 3): the risk
 * list, and moving a mini app out of an agent's folder, which only a person
 * may do, only for a mini app in an agent's folder, and never for a plugin's.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn((key: string) => (key === 'auth' ? { enabled: false } : undefined)),
    set: vi.fn(),
    onChange: vi.fn(() => () => undefined),
  },
}));
vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('../extensions.js', () => ({ broadcastExtensionReloaded: vi.fn() }));

import { Hono } from 'hono';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import type { ExtensionRecord } from '@dorkos/extension-api';

import type { ApiEnv } from '../../http/api-chain.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import type { ExtensionManager } from '../../services/extensions/extension-manager.js';
import { setStepUpExtensionRiskInputs } from '../../services/extensions/step-up/step-up-extension-risk.js';
import { registerExtensionStepUpRoutes } from '../extensions-step-up.js';

const target = swappableServer();
const OWN_ORIGIN = 'http://localhost:4242';

let root: string;
let agentHome: string;
let dorkHome: string;
let records: ExtensionRecord[];
const reload = vi.fn(async () => []);

function record(id: string, folder: string, extra: Partial<ExtensionRecord> = {}): ExtensionRecord {
  return {
    id,
    manifest: { id, name: 'Social queue' },
    status: 'active',
    scope: 'local',
    origin: 'user',
    path: folder,
    realPath: folder,
    ...extra,
  } as unknown as ExtensionRecord;
}

function app() {
  const router = new Hono<ApiEnv>();
  registerExtensionStepUpRoutes(router, {
    manager: { listRecords: () => records, reload } as unknown as ExtensionManager,
    dorkHome,
    safeId: /^[a-z0-9][a-z0-9-]*$/,
  });
  return target.mount(honoGroupListener([{ path: '/api/extensions', routes: router }]));
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ext-step-up-')));
  agentHome = path.join(root, 'agent');
  dorkHome = path.join(root, 'dork');
  const folder = path.join(agentHome, '.dork', 'extensions', 'social-queue');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'extension.json'), '{}');
  records = [record('social-queue', folder)];
  setStepUpExtensionRiskInputs(() => ({
    records,
    approvals: {},
    agents: [{ path: agentHome, name: 'dorkos-marketing' }],
  }));
  reload.mockClear();
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the step-up risk list', () => {
  it('names each loaded mini app that keeps confirming off', async () => {
    const res = await request(app()).get('/api/extensions/step-up-risks');
    expect(res.body).toEqual({
      risks: [
        {
          id: 'social-queue',
          name: 'Social queue',
          reason: 'agent-folder',
          agentName: 'dorkos-marketing',
        },
      ],
    });
  });
});

describe('POST /api/extensions/:id/move-out', () => {
  it('moves it for a person, and rescans', async () => {
    const res = await request(app())
      .post('/api/extensions/social-queue/move-out')
      .set('Origin', OWN_ORIGIN);
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(dorkHome, 'extensions', 'social-queue', 'extension.json'))).toBe(
      true
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('refuses an agent, and moves nothing', async () => {
    const res = await request(app())
      .post('/api/extensions/social-queue/move-out')
      .set('Origin', OWN_ORIGIN)
      .set('X-DorkOS-Agent', 'agent-1');
    expect(res.status).toBe(403);
    expect(fs.existsSync(path.join(dorkHome, 'extensions', 'social-queue'))).toBe(false);
  });

  it('refuses a mini app that is not in an agent’s folder', async () => {
    const elsewhere = path.join(dorkHome, 'extensions', 'notes');
    fs.mkdirSync(elsewhere, { recursive: true });
    records = [record('notes', elsewhere)];
    const res = await request(app())
      .post('/api/extensions/notes/move-out')
      .set('Origin', OWN_ORIGIN);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not-movable');
  });

  it('refuses a plugin’s copy', async () => {
    records = [record('social-queue', records[0]!.path, { sourcePlugin: 'some-plugin' })];
    const res = await request(app())
      .post('/api/extensions/social-queue/move-out')
      .set('Origin', OWN_ORIGIN);
    expect(res.status).toBe(409);
    expect(fs.existsSync(records[0]!.path)).toBe(true);
  });
});
