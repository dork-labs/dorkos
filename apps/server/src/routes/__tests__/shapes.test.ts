/**
 * Tests for the Shapes router (`routes/shapes.ts`, DOR-355 §9).
 *
 * Drives the real router with a temp dorkHome (for the disk-backed list + fork)
 * and injected fake apply collaborators. Asserts each endpoint's contract —
 * including the `applied` chrome passthrough and the degradation `warnings[]` —
 * plus the 404 (not installed) and 409 (fork name taken) mappings.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import type { Logger } from '@dorkos/shared/logger';
import type { ApplyShapeDeps } from '../../services/shapes/apply-shape.js';
import type { ForkShapeDeps } from '../../services/shapes/fork.js';
import { createFsShapeManifestResolver } from '../../services/shapes/shape-services.js';
import { createShapesRouter } from '../shapes.js';

function buildLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** A valid Linear-Ops-shaped manifest with one activated extension, agent, schedule, and secret. */
function shapeManifest(name = 'linear-ops') {
  return {
    schemaVersion: 1,
    name,
    version: '1.0.0',
    type: 'shape',
    displayName: 'Linear Ops',
    description: 'Linear on the dashboard.',
    author: 'dorkos',
    layers: ['extensions', 'agents', 'tasks'],
    requires: [],
    activates: ['linear-issues'],
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
      { kind: 'extension-secret', extension: 'linear-issues', secret: 'linear_api_key' },
    ],
  };
}

async function installShapeOnDisk(dorkHome: string, name: string): Promise<void> {
  const root = path.join(dorkHome, 'shapes', name);
  await mkdir(path.join(root, '.dork'), { recursive: true });
  await writeFile(
    path.join(root, '.dork', 'manifest.json'),
    JSON.stringify(shapeManifest(name), null, 2),
    'utf-8'
  );
  await mkdir(path.join(root, '.claude-plugin'), { recursive: true });
  await writeFile(
    path.join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '1.0.0', description: 'x' }, null, 2),
    'utf-8'
  );
}

describe('shapes router', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  /** Build an app wired to a temp dorkHome with `linear-ops` installed on disk. */
  async function buildApp(activeShape: string | null = null) {
    const dorkHome = await mkdtemp(path.join(tmpdir(), 'shapes-router-'));
    cleanupDirs.push(dorkHome);
    await installShapeOnDisk(dorkHome, 'linear-ops');

    const setActiveShape = vi.fn();
    const applyDeps: ApplyShapeDeps = {
      manifestResolver: createFsShapeManifestResolver(dorkHome),
      extensionManager: {
        get: () => ({ manifest: { serverCapabilities: {} } }),
        enable: async () => ({ reloadRequired: true }),
      },
      secretChecker: { isSet: async () => false }, // secret unset → a warning
      agentRegistry: { listWithPaths: () => [] }, // agent absent → offered
      scheduleService: { existingScheduleNames: () => [], createSchedule: async () => undefined },
      configStore: {
        getShapePrefs: () => ({ active: activeShape, agentDefaults: {}, autoFollowAgent: false }),
        setActiveShape,
      },
    };
    const forkDeps: ForkShapeDeps = { dorkHome, logger: buildLogger() };

    const app = express();
    app.use(express.json());
    app.use('/api/shapes', createShapesRouter({ dorkHome, applyDeps, forkDeps }));
    return { app, dorkHome, setActiveShape };
  }

  it('GET /api/shapes lists installed Shapes with the active flag', async () => {
    const { app } = await buildApp('linear-ops');
    const res = await request(app).get('/api/shapes');
    expect(res.status).toBe(200);
    expect(res.body.shapes).toHaveLength(1);
    expect(res.body.shapes[0]).toMatchObject({
      name: 'linear-ops',
      displayName: 'Linear Ops',
      active: true,
    });
  });

  it('POST /api/shapes/:name/apply returns the §5 contract (applied chrome + warnings + offers)', async () => {
    const { app, setActiveShape } = await buildApp();
    const res = await request(app).post('/api/shapes/linear-ops/apply').send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.applied.layout.sidebarTab).toBe('overview');
    expect(res.body.applied.activatedExtensions).toEqual(['linear-issues']);
    // Degradation passthrough: unset secret + absent agent both surface as warnings.
    expect(res.body.warnings).toContain(
      "Connection 'linear_api_key' for 'linear-issues' needs setup"
    );
    expect(res.body.warnings).toContain("Agent 'tender' not present — offered");
    expect(res.body.offeredAgents[0]).toMatchObject({ ref: 'tender', satisfied: false });
    expect(setActiveShape).toHaveBeenCalledWith('linear-ops');
  });

  it('POST /api/shapes/:name/apply returns 404 when the Shape is not installed', async () => {
    const { app } = await buildApp();
    const res = await request(app).post('/api/shapes/ghost/apply').send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Shape 'ghost' is not installed");
  });

  it('POST /api/shapes/:name/fork clones with lineage (201)', async () => {
    const { app, dorkHome } = await buildApp();
    const res = await request(app).post('/api/shapes/linear-ops/fork').send({ as: 'my-ops' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('my-ops');
    expect(res.body.forkedFrom).toBe('linear-ops@local');
    expect(res.body.installPath).toBe(path.join(dorkHome, 'shapes', 'my-ops'));
  });

  it('POST /api/shapes/:name/fork returns 404 for a missing source Shape', async () => {
    const { app } = await buildApp();
    const res = await request(app).post('/api/shapes/ghost/fork').send({});
    expect(res.status).toBe(404);
  });

  it('POST /api/shapes/:name/fork returns 409 when the target name is taken', async () => {
    const { app, dorkHome } = await buildApp();
    await installShapeOnDisk(dorkHome, 'taken');
    const res = await request(app).post('/api/shapes/linear-ops/fork').send({ as: 'taken' });
    expect(res.status).toBe(409);
  });

  it('POST /api/shapes/:name/fork returns 400 for a malformed target name (--as)', async () => {
    // A bad name in the request BODY is a client error (400), not a conflict
    // (409) with an existing Shape.
    const { app } = await buildApp();
    const res = await request(app).post('/api/shapes/linear-ops/fork').send({ as: 'Not A Slug!' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/kebab-case slug/);
  });

  describe('path traversal via :name (security)', () => {
    // Express URL-decodes route params, so `..%2F..%2Fsecret` reaches the
    // handler as `../../secret` — which, joined into `{dorkHome}/shapes/<name>`,
    // escapes the shapes/ root. Both :name handlers must 400 before any
    // filesystem resolution. (The proven exploit: fork copied a tree from
    // OUTSIDE shapes/ and returned 201.)
    it('POST /api/shapes/:name/apply rejects a traversal name with 400', async () => {
      const { app } = await buildApp();
      const res = await request(app).post('/api/shapes/..%2F..%2Fsecret/apply').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/kebab-case slug/);
    });

    it('POST /api/shapes/:name/fork rejects a traversal name with 400 and copies nothing', async () => {
      const { app, dorkHome } = await buildApp();
      // Plant a directory OUTSIDE shapes/ that the exploit would have cloned.
      const secretDir = path.join(dorkHome, 'secret');
      await mkdir(secretDir, { recursive: true });
      await writeFile(path.join(secretDir, 'credentials.txt'), 'TOP SECRET', 'utf-8');

      // `{dorkHome}/shapes/../../secret` — for a temp dorkHome at <parent>/<home>,
      // two levels up from shapes/ is <parent>; target dorkHome/secret via one
      // level: shapes/../secret. Use the one-level form the exploit used.
      const res = await request(app).post('/api/shapes/..%2Fsecret/fork').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/kebab-case slug/);

      // Nothing was cloned into shapes/ and no fork target appeared anywhere.
      const shapeEntries = await readdir(path.join(dorkHome, 'shapes'));
      expect(shapeEntries.sort()).toEqual(['linear-ops']);
    });

    it('still 404s for a well-formed but absent name (semantics preserved)', async () => {
      const { app } = await buildApp();
      const applyRes = await request(app).post('/api/shapes/ghost/apply').send({});
      expect(applyRes.status).toBe(404);
      const forkRes = await request(app).post('/api/shapes/ghost/fork').send({});
      expect(forkRes.status).toBe(404);
    });
  });
});
