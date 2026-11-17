/**
 * Applying a Shape turns on its extensions and schedules, so a person's apply
 * waits for the owner to confirm it's them (DOR-4355). Forking one, which only
 * copies it, stays immediate.
 *
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplyShapeDeps } from '../../services/shapes/apply-shape.js';
import { createFsShapeManifestResolver } from '../../services/shapes/shape-services.js';
import { createShapesRoutes } from '../shapes.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

const SHAPE = 'northwind-ops';

/** Write an installed Shape with one extension, agent, schedule and secret. */
function installShapeOnDisk(dorkHome: string, name: string): void {
  const root = path.join(dorkHome, 'shapes', name);
  mkdirSync(path.join(root, '.dork'), { recursive: true });
  writeFileSync(
    path.join(root, '.dork', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name,
      version: '1.0.0',
      type: 'shape',
      displayName: 'Northwind Ops',
      description: 'Northwind on the dashboard.',
      author: 'northwind',
      layers: ['extensions', 'agents', 'tasks'],
      requires: [],
      activates: ['northwind-tool'],
      extensions: [],
      layout: {
        sidebarOpen: true,
        sidebarTab: 'overview',
        openPanels: [],
        focusDashboardSections: [],
      },
      agents: [{ ref: 'tender', affinity: 'default', template: { displayName: 'Tender' } }],
      schedules: [
        {
          name: 'tick',
          description: 'poll',
          prompt: 'go',
          cron: '*/15 * * * *',
          agentRef: 'tender',
          permissionMode: 'acceptEdits',
        },
      ],
      connections: [
        { kind: 'extension-secret', extension: 'northwind-tool', secret: 'northwind_api_key' },
      ],
    })
  );
  mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(
    path.join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '1.0.0', description: 'Northwind fixture' })
  );
}

describe('Shape apply confirmation', () => {
  const dorkHome = mkdtempSync(path.join(tmpdir(), 'shapes-apply-step-up-'));
  const setActiveShape = vi.fn();
  const applyDeps: ApplyShapeDeps = {
    manifestResolver: createFsShapeManifestResolver(dorkHome),
    extensionManager: {
      get: () => ({ manifest: { serverCapabilities: {} } }),
      enable: async () => ({ reloadRequired: false }),
      disable: async () => undefined,
    },
    secretChecker: { isSet: async () => false },
    agentRegistry: { listWithPaths: () => [] },
    scheduleService: {
      listSchedules: () => [],
      createSchedule: async () => ({ created: true }) as const,
      rebindSchedule: async () => undefined,
      deleteSchedulesForShape: async () => [],
    },
    configStore: {
      getShapePrefs: () => ({ active: null, agentDefaults: {}, autoFollowAgent: false }),
      setActiveShape,
    },
  };
  const owner = frontDoorStepUpHarness(() => [
    {
      path: '/api/shapes',
      routes: createShapesRoutes({
        dorkHome,
        applyDeps,
        forkDeps: {
          dorkHome,
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
          getActiveShape: () => null,
          getEnabledExtensions: () => [],
        },
      }),
    },
  ]);
  beforeAll(() => installShapeOnDisk(dorkHome, SHAPE));
  afterAll(() => rmSync(dorkHome, { recursive: true, force: true }));
  beforeEach(() => setActiveShape.mockClear());

  it.each(['direct', 'own-tunnel'] as const)('holds a person’s apply from %s', async (via) => {
    const held = await owner.call('post', `/api/shapes/${SHAPE}/apply`, via).send({});
    expect(held.status).toBe(428);
    expect(setActiveShape).not.toHaveBeenCalled();
    expect((await owner.confirm(held.body.heldActionId, via, true)).body.code).toBe(
      'not-your-action'
    );
    expect(setActiveShape).not.toHaveBeenCalled();
    expect((await owner.confirm(held.body.heldActionId, via)).body).toMatchObject({
      ok: true,
      status: 200,
      result: { ok: true },
    });
    expect(setActiveShape).toHaveBeenCalledExactlyOnceWith(SHAPE);
  });

  it('answers a Shape that is not installed before asking anyone', async () => {
    const res = await owner
      .call('post', '/api/shapes/northwind-ghost/apply', 'own-tunnel')
      .send({});
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Shape 'northwind-ghost' is not installed" });
  });

  it('forks one at once', async () => {
    const res = await owner
      .call('post', `/api/shapes/${SHAPE}/fork`, 'own-tunnel')
      .send({ as: 'northwind-copy' });
    expect(res.status).toBe(201);
    expect(res.body.heldActionId).toBeUndefined();
    expect(setActiveShape).not.toHaveBeenCalled();
  });
});
