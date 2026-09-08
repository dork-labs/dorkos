/**
 * `GET /api/harness/status` over HTTP — the never-writes claim, both boundary
 * cases, and the envelope (spec `harness-sync-status` §Testing Strategy,
 * "Route — supertest").
 *
 * Driven through supertest against the REAL router, the REAL boundary module
 * and real `mkdtemp` trees, because every claim here is about a seam: what the
 * validator resolves, what the status model then reads, and what is left on
 * disk afterwards. A mocked filesystem or a mocked validator would let the
 * fixture and the route agree with each other while both were wrong — which is
 * exactly how DOR-678 shipped.
 *
 * **No config store is opened.** The router takes its hook-decision reader as a
 * dependency and this suite passes its own, so `configManager` is never
 * initialized here. That is not a convenience: it is half the proof. A route
 * that reached for the running server's store itself would throw on an
 * uninitialized singleton rather than pass quietly, and a route that opened a
 * store of its own would create `config.json` inside the dork-home this suite
 * snapshots.
 *
 * **No fake `HookApprovalGateway` either, yet.** The spec's fixture pairs the
 * temp repo with one, and it belongs to `POST /api/harness/sync` (slice 7) —
 * the GET raises no approval card and reaches no gateway, so wiring one in now
 * would be a prop no test reads, the same reason the spec gives for keeping
 * `FakeAgentRuntime` out of this file.
 *
 * Every case names the seeded defect that reds it: this route does not exist on
 * `main`, so "fails on main" is trivially true and proves nothing.
 *
 * @module routes/__tests__/harness
 */
import { describe, expect, it, afterEach, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { diffSnapshots, snapshotTree } from '@dorkos/harness/journeys';
import { HarnessStatusResponseSchema } from '@dorkos/shared/harness-schemas';
import { initBoundary } from '../../lib/boundary.js';
import type { HookDecisions } from '../../services/harness/hook-consent.js';
import { createHarnessRouter } from '../harness.js';

/** Nobody has decided anything — the shape every case here runs under. */
const NO_DECISIONS: HookDecisions = { approved: [], refused: [] };

/**
 * The boundary root, the DorkOS data directory, and a directory outside both.
 *
 * Dork-home sits OUTSIDE the boundary on purpose: `{dorkHome}/agents/*` being
 * reachable anyway is the whole subject of the second boundary case, and a
 * dork-home nested inside the boundary would pass it for the wrong reason.
 */
let boundaryRoot: string;
let dorkHome: string;
let outside: string;

/** Temp directories to remove when the suite ends. */
const staged: string[] = [];

const app = express();
const testServer = listeningServer(app);

beforeAll(async () => {
  boundaryRoot = realpathSync(mkdtempSync(join(tmpdir(), 'harness-route-boundary-')));
  dorkHome = realpathSync(mkdtempSync(join(tmpdir(), 'harness-route-home-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'harness-route-outside-')));
  staged.push(boundaryRoot, dorkHome, outside);
  await initBoundary(boundaryRoot);
  // `validateBoundaryOrDorkHome` resolves `{dorkHome}/agents` off this, and
  // caches by the raw value, so stubbing it here is enough.
  vi.stubEnv('DORK_HOME', dorkHome);
  app.use('/api/harness', createHarnessRouter({ dorkHome, readHookDecisions: () => NO_DECISIONS }));
});

afterAll(() => {
  vi.unstubAllEnvs();
  for (const dir of staged.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A fresh project directory inside the boundary. */
function stageProject(tag: string): string {
  const repo = mkdtempSync(join(boundaryRoot, `${tag}-`));
  staged.push(repo);
  return repo;
}

/** Write a file, creating the directories above it. */
function writeAt(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

/** Write the manifest that turns a bare directory into a set-up project. */
function writeManifest(repo: string, harnesses: string[]): void {
  writeAt(
    join(repo, '.agents', 'harness.manifest.json'),
    `${JSON.stringify({ version: 1, harnesses }, null, 2)}\n`
  );
}

/** The status read, as a client makes it. */
function readStatus(projectPath: string) {
  return request(testServer)
    .get('/api/harness/status')
    .query({ projectPath })
    .then((res) => res);
}

/** A diff naming nothing — what a read is allowed to leave behind. */
const NO_CHANGES = { added: [], changed: [], removed: [] };

describe('GET /api/harness/status', () => {
  it('AP-03 / DOR-678: a manifest-less project answers not-set-up and the tree is byte-identical after', async () => {
    // Seeded defect: call `scaffoldManifest` in the route (as `--check` once
    // did) and the repo snapshot diverges by the manifest it wrote. The
    // snapshot is the assertion, not the status code: the status code was
    // already right on the day DOR-678 shipped the bug.
    const repo = stageProject('bare');
    writeAt(join(repo, 'README.md'), '# nothing set up here\n');

    const beforeRepo = snapshotTree(repo);
    const beforeHome = snapshotTree(dorkHome);
    const res = await readStatus(repo);

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('not-set-up');
    expect(res.body.projectPath).toBe(repo);
    expect(res.body).toMatchObject({
      enabled: [],
      notEnabled: [],
      rows: [],
      projectLevel: [],
      pendingApproval: [],
      sweepPreview: [],
      clean: true,
    });
    expect(diffSnapshots(beforeRepo, snapshotTree(repo))).toEqual(NO_CHANGES);
    // The other half of DOR-678's rule: no config store was created either.
    expect(diffSnapshots(beforeHome, snapshotTree(dorkHome))).toEqual(NO_CHANGES);
  });

  it('answers 200 for an agent home under {dorkHome}/agents, which is outside the boundary', async () => {
    // Seeded defect: swap `validateBoundaryOrDorkHome` for `validateBoundary`
    // and this reds with 403 — the exact regression that would 403 the surface
    // this route is built for, since every DorkOS-managed agent lives here.
    const agentHome = join(dorkHome, 'agents', 'dorkbot');
    mkdirSync(agentHome, { recursive: true });
    writeManifest(agentHome, ['claude-code']);

    const res = await readStatus(agentHome);

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('ready');
    expect(res.body.enabled).toEqual(['claude-code']);
  });

  it('answers 403 for a path outside the boundary', async () => {
    // Seeded defect: drop the validator and this reds with a 200 describing a
    // directory the caller was never allowed to see.
    const res = await readStatus(outside);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
  });

  it('answers 404 for a path inside the boundary that does not exist', async () => {
    // Seeded defect: drop the `stat` and this reds with `200 not-set-up`. The
    // validator does NOT refuse a path that leads nowhere — it canonicalizes
    // through the deepest existing ancestor and returns it, which is what lets
    // a workspace about to be cloned validate — and `buildHarnessStatus` reads
    // ENOENT the same way whether the project is empty or absent. Telling a
    // person "DorkOS isn't sharing agent files for this folder yet" about a
    // folder that is not there is the answer this case exists to prevent.
    const res = await readStatus(join(boundaryRoot, 'no-such-project'));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Project directory not found');
  });

  it('answers 400 for a path inside the boundary that is a file', async () => {
    // Seeded defect: drop the `isDirectory` check and this reds with
    // `200 unreadable` carrying a raw `ENOTDIR: not a directory, open …` where
    // the parse-failure sentence belongs.
    const repo = stageProject('file');
    const file = join(repo, 'notes.md');
    writeAt(file, '# not a project\n');

    const res = await readStatus(file);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Not a directory');
  });

  it('answers 400 when projectPath is missing or blank', async () => {
    // Seeded defect: drop the query schema and a bare call reaches the
    // validator, which resolves `undefined` against the process cwd and answers
    // about whatever repo the server happens to be running in.
    const missing = await request(testServer).get('/api/harness/status');
    expect(missing.status).toBe(400);

    const blank = await readStatus('   ');
    expect(blank.status).toBe(400);
  });

  it('answers unreadable, with the parse failure in words, for a manifest that will not parse', async () => {
    // Seeded defect: let `loadManifest` throw out of the route and this reds
    // with a 500 and a stack in the log, for a file a person can fix in ten
    // seconds if they are told which one it is.
    const repo = stageProject('broken');
    writeAt(join(repo, '.agents', 'harness.manifest.json'), '{ "harnesses": [');

    const res = await readStatus(repo);

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('unreadable');
    expect(res.body.detail).toContain('.agents/harness.manifest.json');
    expect(res.body.rows).toEqual([]);
  });

  it('answers the status model as-is, and writes nothing to a project that IS set up', async () => {
    // Seeded defect: reshape the response in the route — drop a field, rename
    // one — and the schema parse reds. The response IS the status model, so a
    // second voice here is a page and a CLI that describe one tree two ways.
    const repo = stageProject('ready');
    writeManifest(repo, ['claude-code', 'codex']);
    writeAt(join(repo, 'CLAUDE.md'), '# Our project\n');
    writeAt(
      join(repo, '.claude', 'skills', 'release', 'SKILL.md'),
      '---\nname: release\ndescription: The release skill\n---\n\n# release\n'
    );

    const before = snapshotTree(repo);
    const res = await readStatus(repo);

    expect(res.status).toBe(200);
    const parsed = HarnessStatusResponseSchema.safeParse(res.body);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(res.body.state).toBe('ready');
    expect(res.body.enabled).toEqual(['claude-code', 'codex']);
    expect(res.body.counts.skills).toBeGreaterThan(0);
    expect(diffSnapshots(before, snapshotTree(repo))).toEqual(NO_CHANGES);
  });
});
