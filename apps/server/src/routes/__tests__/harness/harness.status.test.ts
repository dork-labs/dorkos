/**
 * `GET /api/harness/status` over HTTP: the never-writes claim, both boundary
 * cases, and the envelope (spec `harness-sync-status`, "Route — supertest").
 * Setup and why it is real: `harness.fixtures.ts`.
 *
 * @module routes/__tests__/harness/harness.status
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import request from '@dorkos/test-utils/supertest';
import { diffSnapshots, snapshotTree } from '@dorkos/harness/journeys';
import { HarnessStatusResponseSchema } from '@dorkos/shared/harness-schemas';
import { logger } from '../../../lib/logger.js';
import {
  NO_CHANGES,
  READ_FAILURE,
  paths,
  readStatus,
  stageProject,
  staged,
  useHarnessRoutes,
  writeAt,
  writeManifest,
} from './harness.fixtures.js';

const servers = useHarnessRoutes({ realConfig: true });

describe('GET /api/harness/status', () => {
  it('AP-03 / DOR-678: a manifest-less project answers not-set-up and the tree is byte-identical after', async () => {
    // Seeded defect: call `scaffoldManifest` in the route (as `--check` once
    // did) and the repo snapshot diverges by the manifest it wrote. The
    // snapshot is the assertion, not the status code: the status code was
    // already right on the day DOR-678 shipped the bug.
    const repo = stageProject('bare');
    writeAt(join(repo, 'README.md'), '# nothing set up here\n');

    const beforeRepo = snapshotTree(repo);
    const beforeHome = snapshotTree(paths.dorkHome);
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
    expect(diffSnapshots(beforeHome, snapshotTree(paths.dorkHome))).toEqual(NO_CHANGES);
  });

  it('answers 200 for an agent home under {dorkHome}/agents, which is outside the boundary', async () => {
    // Seeded defect: swap `validateBoundaryOrDorkHome` for `validateBoundary`
    // and this reds with 403 — the exact regression that would 403 the surface
    // this route is built for, since every DorkOS-managed agent lives here.
    const agentHome = join(paths.dorkHome, 'agents', 'dorkbot');
    mkdirSync(agentHome, { recursive: true });
    writeManifest(agentHome, ['claude-code']);

    const res = await readStatus(agentHome);

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('ready');
    expect(res.body.enabled).toEqual(['claude-code']);
  });

  it('TR-11: reports the agent tool DorkOS runs here when the project does not enable it', async () => {
    // Seeded defect: stop passing `dorkosHarness` into `buildHarnessStatus` and
    // `notEnabled` comes back empty — which is what shipped, and why the panel
    // was silent about the one tool that leaves no files behind to detect
    // (DOR-1901). There is no `.claude/` in this tree, on purpose: a footprint
    // would make the assertion pass for the other reason.
    const repo = stageProject('opencode-only');
    writeManifest(repo, ['codex', 'opencode']);
    writeAt(join(repo, 'AGENTS.md'), '# House rules\n');
    const before = snapshotTree(repo);

    const res = await readStatus(repo);

    expect(res.status).toBe(200);
    expect(res.body.notEnabled).toEqual([{ harness: 'claude-code', why: 'dorkos-runtime' }]);
    // A report, not a repair: the panel says it, the person runs `--enable`.
    expect(diffSnapshots(before, snapshotTree(repo))).toEqual(NO_CHANGES);
  });

  it('answers 403 for a path outside the boundary', async () => {
    // Seeded defect: drop the validator and this reds with a 200 describing a
    // directory the caller was never allowed to see.
    const res = await readStatus(paths.outside);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
  });

  // Seeded defects, one per row: drop the query schema (a bare call resolves
  // `undefined` against the server cwd), the `isAbsolute` refinement (a relative
  // path lands wherever the operator started the process), the `stat` (a folder
  // that is not there reads as `200 not-set-up`, because the validator
  // canonicalizes through the deepest existing ancestor), or the `isDirectory`
  // check (a raw `ENOTDIR` where the parse-failure sentence belongs).
  it.each([
    ['no projectPath', 400, () => undefined, undefined],
    ['a blank projectPath', 400, () => '   ', undefined],
    [
      'a relative projectPath',
      400,
      () => 'some/relative/project',
      'projectPath must be an absolute path',
    ],
    [
      'a folder that does not exist',
      404,
      () => join(paths.boundaryRoot, 'no-such-project'),
      'Project directory not found',
    ],
    [
      'a path that is a file',
      400,
      () => {
        const file = join(stageProject('file'), 'notes.md');
        writeAt(file, '# not a project\n');
        return file;
      },
      'Not a directory',
    ],
  ] as const)('answers %s with %i', async (_case, status, target, words) => {
    const projectPath = target();
    const res =
      projectPath === undefined
        ? await request(servers.testServer).get('/api/harness/status')
        : await readStatus(projectPath);
    expect(res.status).toBe(status);
    if (words) expect(JSON.stringify(res.body)).toContain(words);
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
    // The model's numbers are `status-model.test.ts`'s; here, that they arrive.
    expect(res.body.counts.adoptable).toBe(1);
    expect(res.body.projectLevel).toEqual([]);
    expect(res.body.sweepPreview).toEqual([]);
    expect(diffSnapshots(before, snapshotTree(repo))).toEqual(NO_CHANGES);
  });

  it('answers 500 with nothing of the failure in it when a dependency throws', async () => {
    // Seeded defect: echo `err.message` into the body — `{ error: toErrorMessage(err) }`
    // — and this reds. Every other case here stays green through
    // that change, because none of them can reach the 500 path at all: the state
    // a person can act on is always a 200, so the only way in is a dependency
    // that breaks, and the only thing worth asserting about it is what does NOT
    // come back.
    const errors = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    const repo = stageProject('boom');
    writeManifest(repo, ['claude-code']);

    const res = await request(servers.failingServer)
      .get('/api/harness/status')
      .query({ projectPath: repo });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    // Not just the message: nothing the failure carried, in any field.
    expect(JSON.stringify(res.body)).not.toContain('private-notes');
    expect(JSON.stringify(res.body)).not.toContain('config store');
    // And it was not silently swallowed either — the operator can still see it.
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0]?.[0]).toBe('[harness] GET /status failed');
    expect(errors.mock.calls[0]?.[1]).toMatchObject({ err: READ_FAILURE, projectPath: repo });
  });

  it('SRC-08, J-07: carries what Claude Code alone has, with the root it was read from', async () => {
    // Seeded defect one: compute `claudeOnly` inside `buildHarnessStatus`
    // instead. The model is a pure function of what it is handed and resolves no
    // roots, so it has no way to read this and the field arrives undefined.
    // Seeded defect two: let the read throw rather than answer with its own
    // record, and the case below this one turns a whole project's status into a
    // 500 over a file in a home directory.
    const claudeRoot = mkdtempSync(join(paths.outside, 'claude-root-'));
    staged.push(claudeRoot);
    writeAt(
      join(claudeRoot, 'settings.json'),
      `${JSON.stringify({
        enabledPlugins: {
          'context7@claude-plugins-official': true,
          'code-reviewer@dorkos': true,
          'switched-off@claude-plugins-official': false,
        },
        extraKnownMarketplaces: {
          'claude-plugins-official': {
            source: { source: 'github', repo: 'anthropics/claude-plugins-official' },
          },
          dorkos: { source: { source: 'github', repo: 'dork-labs/marketplace' } },
        },
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] },
      })}\n`
    );
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeRoot);

    const repo = stageProject('claude-only');
    writeManifest(repo, ['claude-code']);

    const res = await readStatus(repo);

    expect(res.status).toBe(200);
    // The schema accepts it, so the field is on the contract and not just in the
    // body of one response.
    expect(HarnessStatusResponseSchema.safeParse(res.body).error?.issues ?? []).toEqual([]);
    expect(res.body.claudeOnly.root).toBe(claudeRoot);
    expect(res.body.claudeOnly.plugins).toHaveLength(2);
    expect(res.body.claudeOnly.plugins.map((p: { name: string }) => p.name)).toEqual([
      'context7',
      'code-reviewer',
    ]);
    expect(res.body.claudeOnly.personalHookCommands).toBe(1);
    expect(res.body.claudeOnly.mayBeOverridden).toBe(true);
    expect(res.body.claudeOnly.unreadable).toBeUndefined();
    // A plugin nobody turned on is not something anybody is missing.
    expect(JSON.stringify(res.body.claudeOnly)).not.toContain('switched-off');
    // Nothing from that file but names, repositories and counts — no hook
    // command a person wrote reaches the wire.
    expect(JSON.stringify(res.body.claudeOnly)).not.toContain('say done');
  });

  it('SRC-08: an unreadable Claude settings file is a record in the field, never a 500', async () => {
    // Seeded defect: drop the guard and let the settings read throw. The route's
    // own catch turns it into `500 Internal server error`, and a whole project's
    // status is lost over a file this field is a footnote about.
    const claudeRoot = mkdtempSync(join(paths.outside, 'claude-broken-'));
    staged.push(claudeRoot);
    writeAt(join(claudeRoot, 'settings.json'), '{ "enabledPlugins": {,,, ');
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeRoot);

    const repo = stageProject('claude-broken');
    writeManifest(repo, ['claude-code']);

    const res = await readStatus(repo);

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('ready');
    expect(res.body.claudeOnly.root).toBe(claudeRoot);
    expect(res.body.claudeOnly.unreadable).toBeTruthy();
    expect(res.body.claudeOnly.plugins).toEqual([]);
  });
});
