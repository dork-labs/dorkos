/**
 * Tests for the Shapes router (`routes/shapes.ts`, DOR-355 §9).
 *
 * Drives the real router with a temp dorkHome (for the disk-backed list + fork)
 * and injected fake apply collaborators. Asserts each endpoint's contract —
 * including the `applied` chrome passthrough and the degradation `warnings[]` —
 * plus the 404 (not installed) and 409 (fork name taken) mappings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import type { Logger } from '@dorkos/shared/logger';
import { createTestDb } from '@dorkos/test-utils/db';
import type { ApplyShapeDeps } from '../../services/shapes/apply-shape.js';
import type { ForkShapeDeps } from '../../services/shapes/fork.js';
import { createFsShapeManifestResolver } from '../../services/shapes/shape-services.js';
import { ApprovalService } from '../../services/core/approvals/index.js';
import {
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../services/core/capabilities/index.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import { composeCapabilityRegistryForDocs } from '../../services/core/self-description/dorkos-registry.js';
import { APPLY_SHAPE_ACTION, createShapesRouter } from '../shapes.js';

// Local login off — the DEFAULT posture, and therefore the one the gate has to be
// right in. `resolveDecisionAuthority` reads this to decide whether a caller with
// no agent header counts as the person in the cockpit.
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: (key: string) => (key === 'auth' ? { enabled: false } : undefined) },
}));

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
    const createSchedule = vi.fn(async () => ({ created: true }) as const);
    const applyDeps: ApplyShapeDeps = {
      manifestResolver: createFsShapeManifestResolver(dorkHome),
      extensionManager: {
        get: () => ({ manifest: { serverCapabilities: {} } }),
        enable: async () => ({ reloadRequired: true }),
        disable: async () => undefined,
      },
      secretChecker: { isSet: async () => false }, // secret unset → a warning
      agentRegistry: { listWithPaths: () => [] }, // agent absent → offered
      scheduleService: {
        listSchedules: () => [],
        createSchedule,
        rebindSchedule: async () => undefined,
        deleteSchedulesForShape: async () => [],
      },
      configStore: {
        getShapePrefs: () => ({ active: activeShape, agentDefaults: {}, autoFollowAgent: false }),
        setActiveShape,
      },
    };
    // Mirrors the production wiring (`index.ts`): the fork service reads the
    // active Shape and the enabled extensions for itself; only the chrome has to
    // arrive in the request body.
    const forkDeps: ForkShapeDeps = {
      dorkHome,
      logger: buildLogger(),
      getActiveShape: () => activeShape,
      getEnabledExtensions: () => ['linear-issues'],
    };

    const app = express();
    app.use(express.json());
    app.use('/api/shapes', createShapesRouter({ dorkHome, applyDeps, forkDeps }));
    return { app, dorkHome, setActiveShape, createSchedule };
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

  it('POST /api/shapes/:name/fork carries a partial liveLayout through to the forked manifest', async () => {
    // The switcher's capture reaches the service over HTTP: the fields it
    // reports land in the fork, and the ones it omits keep the source's values.
    const { app } = await buildApp('linear-ops');
    const res = await request(app)
      .post('/api/shapes/linear-ops/fork')
      .send({
        as: 'my-ops',
        captureCurrent: true,
        liveLayout: { sidebarOpen: false, openPanels: ['tasks', 'relay'] },
      });

    expect(res.status).toBe(201);
    expect(res.body.manifest.layout).toEqual({
      sidebarOpen: false,
      openPanels: ['tasks', 'relay'],
      sidebarTab: 'overview', // omitted by the client → source value kept
      focusDashboardSections: [], // omitted by the client → source value kept
    });
  });

  it('POST /api/shapes/:name/fork rejects a malformed liveLayout with 400', async () => {
    const { app } = await buildApp('linear-ops');
    const res = await request(app)
      .post('/api/shapes/linear-ops/fork')
      .send({ captureCurrent: true, liveLayout: { openPanels: ['not-a-panel'] } });

    expect(res.status).toBe(400);
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

  // The route's LAST catch arm: `forkShape` re-validates the manifest it built
  // through the marketplace union, and a `ZodError` escaping that is a bad
  // request, not a 500. Reaching it needs a name the two kebab-case gates in
  // front of it accept and the manifest's own `SkillNameSchema` does not — the
  // gap the belt exists for. `SHAPE_NAME_RE` (route) and `SLUG_RE` (fork
  // service) are both `/^[a-z][a-z0-9-]*$/`, which caps nothing and allows a
  // doubled hyphen; `SkillNameSchema` caps at 64 and refuses `--`.
  describe('a forked manifest the union refuses (400, not 500)', () => {
    it.each([
      ['a doubled hyphen', 'my--ops'],
      ['a name past the 64-character cap', 'a'.repeat(65)],
    ])('answers 400 for %s', async (_label, as) => {
      const { app } = await buildApp();
      const res = await request(app).post('/api/shapes/linear-ops/fork').send({ as });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/^Forked manifest failed validation:/);
    });

    it('leaves nothing behind on disk when it refuses', async () => {
      // The re-validate runs BEFORE the install transaction stages anything, so
      // a refused fork is zero-residue — `linear-ops` is still the only Shape.
      const { app, dorkHome } = await buildApp();
      await request(app).post('/api/shapes/linear-ops/fork').send({ as: 'my--ops' });

      expect(await readdir(path.join(dorkHome, 'shapes'))).toEqual(['linear-ops']);
    });
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

  /**
   * The tier gate on apply (DOR-625).
   *
   * `POST /api/shapes/:name/apply` had no gate of any kind — no `authorize`, no
   * trusted-caller check, no confirmation provider — while applying a Shape writes
   * a `SKILL.md` into the operator's own skills root for every schedule it
   * declares, rewrites the active-Shape config, turns extensions on and off, and
   * deletes the schedules an earlier version of the same Shape left behind. That
   * is the blast radius `destructive` names, and the route answered to nothing.
   *
   * Not the permission mode, which this comment used to lead with (DOR-1713): a
   * manifest's `bypassPermissions` is clamped to `acceptEdits` before the row is
   * written (DOR-607) and the row parks at `pending_approval` until a person
   * approves it (DOR-1486). The writing alone is what the tier is for.
   *
   * The two cases below are the whole contract: a person clicking a Shape in their
   * own cockpit sends no agent header and is unaffected; a caller that names itself
   * an agent is asked first.
   */
  describe('POST /api/shapes/:name/apply answers to the tier gate', () => {
    let approvals: ApprovalService;

    beforeEach(() => {
      approvals = new ApprovalService(createTestDb());
      vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
      initCapabilityTierGate({ approvals });
    });

    afterEach(() => {
      resetCapabilityTierGate();
    });

    it('asks a person first when an agent applies a Shape, and nothing is scheduled', async () => {
      const { app, setActiveShape, createSchedule } = await buildApp();

      const res = await request(app)
        .post('/api/shapes/linear-ops/apply')
        .set('x-dorkos-agent', 'dork_agent_token')
        .send({});

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({
        status: 'approval_required',
        capabilityId: 'shapes.apply',
      });
      expect(res.body.approvalToken).toBeTruthy();
      // Read off the collaborators the effect would have reached, never off the
      // response shape: the claim is that the Shape was not applied.
      expect(createSchedule).not.toHaveBeenCalled();
      expect(setActiveShape).not.toHaveBeenCalled();
    });

    it('applies once a person grants the approval and the caller retries', async () => {
      const { app, createSchedule } = await buildApp();

      const asked = await request(app)
        .post('/api/shapes/linear-ops/apply')
        .set('x-dorkos-agent', 'dork_agent_token')
        .send({});
      expect(createSchedule).not.toHaveBeenCalled();

      approvals.grant(asked.body.approvalId as string);

      const done = await request(app)
        .post('/api/shapes/linear-ops/apply')
        .set('x-dorkos-agent', 'dork_agent_token')
        .set('x-dorkos-approval', asked.body.approvalToken as string)
        .send({});

      expect(done.status).toBe(200);
      expect(done.body.ok).toBe(true);
      expect(createSchedule).toHaveBeenCalled();
    });

    it('never asks the person in their own cockpit', async () => {
      // No agent header and no approval token: `resolveDecisionAuthority` calls
      // this the operator, so the gate is skipped and the click just works.
      const { app, setActiveShape } = await buildApp();
      const res = await request(app).post('/api/shapes/linear-ops/apply').send({});
      expect(res.status).toBe(200);
      expect(setActiveShape).toHaveBeenCalledWith('linear-ops');
    });

    /**
     * The id reservation, which is what makes "shapes can migrate to the registry
     * later" a safe thing to say.
     *
     * `APPLY_SHAPE_ACTION` is a `GatedAction`, not a registry capability, so its
     * id lives in the same space as capability ids without anything allocating it.
     * An approval binds to `${id}` + a hash of the input. If somebody registers a
     * `shapes.apply` CAPABILITY tomorrow, two different actions would share one id,
     * and a token minted for one could be spent on the other.
     *
     * `composeCapabilityRegistryForDocs` is the right registry to ask because it
     * composes EVERY domain unconditionally — a domain gated behind absent deps
     * would be missing from the boot registry and this check would pass by not
     * looking.
     *
     * Its own limit, stated rather than implied: that composer's domain list is
     * HARDCODED, so a fourth domain wired into boot but never added there is
     * invisible here. Partly mitigated by the same composer driving the static
     * OpenAPI export, which has its own freshness gate in CI — a domain missing
     * from it tends to surface there first.
     *
     * The id comes from {@link APPLY_SHAPE_ACTION} rather than a literal, so
     * renaming the action moves the reservation with it instead of leaving this
     * guarding a name nothing uses.
     */
    it('reserves the shapes.apply id — no capability may claim it while the route owns it', () => {
      const ids = composeCapabilityRegistryForDocs().capabilities.map((cap) => cap.id);

      // Not empty, or the filter below proves nothing.
      expect(ids.length).toBeGreaterThan(10);
      expect(
        ids.filter((id) => id === APPLY_SHAPE_ACTION.id),
        `a capability now claims \`${APPLY_SHAPE_ACTION.id}\`, which the Shapes route already uses as a ` +
          'GatedAction id. Two actions sharing one id share one approval binding space. ' +
          'Migrate the route onto the capability (delete APPLY_SHAPE_ACTION and use ' +
          'authorizeCapability) rather than letting both exist.'
      ).toEqual([]);
    });

    it('refuses rather than applies when the gate was never wired', async () => {
      // Fail closed. With no approval service there is nobody to ask, and running
      // the effect anyway would turn a wiring mistake into unattended cron jobs.
      resetCapabilityTierGate();
      const { app, createSchedule } = await buildApp();
      const res = await request(app)
        .post('/api/shapes/linear-ops/apply')
        .set('x-dorkos-agent', 'dork_agent_token')
        .send({});

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ status: 'denied', reason: 'enforcement_unavailable' });
      expect(createSchedule).not.toHaveBeenCalled();
    });
  });
});
