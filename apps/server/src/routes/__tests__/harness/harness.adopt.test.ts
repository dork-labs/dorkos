/**
 * `POST /api/harness/adopt` over HTTP. Setup and why it is real:
 * `harness.fixtures.ts`; the login-on case is in `harness.sync.test.ts`, which
 * stands in for the session gate.
 *
 * @module routes/__tests__/harness/harness.adopt
 */
import { describe, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from '@dorkos/test-utils/supertest';
import { diffSnapshots, snapshotTree } from '@dorkos/harness/journeys';
import { HarnessAdoptResponseSchema } from '@dorkos/shared/harness-schemas';
import {
  projectLockQueueDepth,
  withProjectLock,
} from '../../../services/harness/project-with-consent.js';
import {
  NO_CHANGES,
  adoptSkill,
  paths,
  stageAdoptProject,
  stageProject,
  staged,
  useHarnessRoutes,
  writeAt,
} from './harness.fixtures.js';

const servers = useHarnessRoutes({ realConfig: true });

describe('POST /api/harness/adopt', () => {
  it('SK-16: a gitignored .agents/ blocks the whole run, and the answer is one refusal', async () => {
    // A blocked plan is a fact about the DIRECTORY (AP-15), not about this
    // skill, and it stops every candidate at once — so it rides back as the
    // refusal for the name the caller asked about rather than as a second shape
    // the page would have to learn. Seeded defect: send the blocked plan into
    // `applyAdopt` and the run moves a skill into a folder git has been told to
    // ignore, taking it out of the repository for everybody who clones it.
    const repo = stageAdoptProject('adopt-blocked');
    // The matcher answers only inside a git checkout, which is the whole reason
    // this directory is here.
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeAt(join(repo, '.gitignore'), '.agents/\n');
    const before = snapshotTree(repo);

    const res = await adoptSkill(repo, 'release-notes');

    expect(res.status).toBe(200);
    expect(res.body.moved).toEqual([]);
    expect(res.body.declared).toEqual([]);
    expect(res.body.refusals).toHaveLength(1);
    expect(res.body.refusals[0].rule).toBe('canonical-layer-ignored');
    expect(res.body.refusals[0].name).toBe('release-notes');
    expect(res.body.refusals[0].reason).toContain('.gitignore');
    expect(res.body.refusals[0].reason).not.toBe('');
    // The wire shape is a closed enum, so a rule the schema does not know is a
    // parse failure here rather than a string the page cannot branch on.
    expect(HarnessAdoptResponseSchema.safeParse(res.body).success).toBe(true);
    expect(diffSnapshots(before, snapshotTree(repo))).toEqual(NO_CHANGES);
  });
  it('SRC-11: an agent home adopts through the route with its ownership resolved, not assumed', async () => {
    // The route asks `resolveDirectoryOwnership` (DOR-1945) instead of passing
    // the literal `'plain'`. Under dork home the only shape the boundary lets a
    // request reach is `{dorkHome}/agents/*`, so this is the reachable half of
    // the wiring: an agent home resolves to `agent-home`, and an explicit adopt
    // there still moves the skill. A room worktree (`{dorkHome}/rooms/*/
    // worktrees/*`) is where R3 would fire, but the boundary refuses it before
    // the route runs, so it is pinned by the resolver's own suite instead.
    const repo = join(paths.dorkHome, 'agents', 'route-adopt-home');
    mkdirSync(repo, { recursive: true });
    staged.push(repo);
    stageAdoptProject('', repo);

    const res = await adoptSkill(repo, 'release-notes');

    expect(res.status).toBe(200);
    expect(res.body.moved.map((m: { name: string }) => m.name)).toEqual(['release-notes']);
    expect(res.body.refusals).toEqual([]);
  });
  it('SRC-07, SRC-10, AP-17: moves the skill, leaves Claude Code its link, and the RETURNED status says so', async () => {
    // Seeded defect: recompute the status BEFORE the apply — or answer with the
    // status the GET before the click produced — and the row still reads
    // `harness-native` with Codex unable to see it, which is exactly the chip
    // the page flips off this response.
    const repo = stageAdoptProject('adopt-move');

    const res = await adoptSkill(repo, 'release-notes');

    expect(res.status).toBe(200);
    expect(HarnessAdoptResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.refusals).toEqual([]);
    expect(res.body.moved).toHaveLength(1);
    expect(res.body.moved[0]).toMatchObject({
      name: 'release-notes',
      from: '.claude/skills/release-notes',
      to: '.agents/skills/release-notes',
      link: { target: '.claude/skills/release-notes' },
    });

    // On disk, which is the only place this is true or false.
    expect(existsSync(join(repo, '.agents', 'skills', 'release-notes', 'SKILL.md'))).toBe(true);
    expect(lstatSync(join(repo, '.claude', 'skills', 'release-notes')).isSymbolicLink()).toBe(true);

    // And in the answer the page renders without asking again.
    const rows = res.body.status.rows.filter(
      (row: { artifact: string; name: string }) =>
        row.artifact === 'skill' && row.name === 'release-notes'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].provenance).toBe('authored');
    expect(rows[0].adoptable).toBe(false);
    expect(rows[0].cells.codex.state).toBe('native');
    // `projected`, which is the state the page draws as the chip reading
    // "Claude Code shared": the link the move left behind is the projection.
    expect(rows[0].cells['claude-code'].state).toBe('projected');
  });

  it('VC-05: refuses a caller naming itself an agent with the same shape the sync refuses one', async () => {
    // Seeded defect: swap `resolveDecisionAuthority` for `trustedCaller` and the
    // person-in-a-terminal case below reds under login-on (DOR-502's shape);
    // drop the bar entirely and the first call moves a file a person wrote.
    // The two refusals are compared field by field rather than by eye, so the
    // adopt's answer cannot drift away from the sync's.
    const repo = stageAdoptProject('adopt-agent');

    const refusedAdopt = await request(servers.testServer)
      .post('/api/harness/adopt')
      .set('X-DorkOS-Agent', 'some-agent-token')
      .send({ projectPath: repo, name: 'release-notes' });
    const refusedSync = await request(servers.testServer)
      .post('/api/harness/sync')
      .set('X-DorkOS-Agent', 'some-agent-token')
      .send({ projectPath: repo });

    expect(refusedAdopt.status).toBe(refusedSync.status);
    expect(refusedAdopt.status).toBe(403);
    expect(Object.keys(refusedAdopt.body).sort()).toEqual(Object.keys(refusedSync.body).sort());
    expect(refusedAdopt.body.code).toBe('person_only');
    expect(refusedAdopt.body.detail).toBe('Only a person can move a skill, in DorkOS.');

    // Ahead of validation, so a caller that may not do this at all gets one
    // answer whatever it sent rather than a schema it can probe.
    const probed = await request(servers.testServer)
      .post('/api/harness/adopt')
      .set('X-DorkOS-Agent', 'some-agent-token')
      .send({ projectPath: 42 });
    expect(probed.status).toBe(403);

    // And the same call without the header works, so this is a bar rather than
    // a wall: nothing moved above, so the skill is still there to move.
    expect((await adoptSkill(repo, 'release-notes')).status).toBe(200);
  });

  it('VC-05: answers 409 with no manifest, 400 for a relative path or a blank name, and 404 for nowhere', async () => {
    // Each is asserted separately, because "inherited from the sync" is a claim.
    // Seeded defect: drop the module's own `.refine` and the relative path
    // reaches `resolveProject`, which resolves it against the server's cwd —
    // a MOVE inside whatever repository the operator happened to start in.
    const bare = stageProject('adopt-bare');
    writeAt(join(bare, 'README.md'), '# nothing set up here\n');
    const before = snapshotTree(bare);

    const noManifest = await adoptSkill(bare, 'release-notes');
    expect(noManifest.status).toBe(409);
    expect(noManifest.body.code).toBe('conflict');
    expect(diffSnapshots(before, snapshotTree(bare))).toEqual(NO_CHANGES);

    const relative = await adoptSkill('some/relative/project', 'release-notes');
    expect(relative.status).toBe(400);
    expect(JSON.stringify(relative.body)).toContain('projectPath must be an absolute path');

    const repo = stageAdoptProject('adopt-bad-name');
    expect((await adoptSkill(repo, '   ')).status).toBe(400);
    expect((await request(servers.testServer).post('/api/harness/adopt').send({})).status).toBe(
      400
    );

    const nowhere = await adoptSkill(join(paths.boundaryRoot, 'no-such-project'), 'release-notes');
    expect(nowhere.status).toBe(404);

    const outsideBoundary = await adoptSkill(paths.outside, 'release-notes');
    expect(outsideBoundary.status).toBe(403);
  });

  it('SK-16: answers 200 with the refusal in the body, not a 4xx, and moves nothing', async () => {
    // A refusal is an answer carrying its own way out, and the page draws the
    // sentence where the row's advice line was. Seeded defect: map "no such
    // skill" to a 404 and the page has to special-case one refusal out of eight
    // to render the same sentence.
    const repo = stageAdoptProject('adopt-refused');
    const before = snapshotTree(repo);

    const res = await adoptSkill(repo, 'no-such-skill');

    expect(res.status).toBe(200);
    expect(res.body.moved).toEqual([]);
    expect(res.body.refusals).toHaveLength(1);
    expect(res.body.refusals[0].name).toBe('no-such-skill');
    expect(res.body.refusals[0].reason).toBe(
      'There is no skill called "no-such-skill" in .claude/skills. ' +
        'Run dorkos harness sync --check to see what is here.'
    );
    // The status still arrives, so a page that renders the refusal is rendering
    // it beside a tree it can trust.
    expect(res.body.status.state).toBe('ready');
    expect(diffSnapshots(before, snapshotTree(repo))).toEqual(NO_CHANGES);
  });

  it('AP-10: queues behind a projection already running on that repository, then answers 200', async () => {
    // Seeded defect: recompute the status OUTSIDE the lock — or drop
    // `withProjectLock` altogether — and this adopt plans against a tree another
    // writer is half-way through, then answers with a status describing neither.
    // Asserted through the lock's own queue depth rather than a timer, so the
    // case cannot pass by being slow.
    const repo = stageAdoptProject('adopt-lock');
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const turn = withProjectLock(repo, () => held);

    const post = adoptSkill(repo, 'release-notes');
    await vi.waitFor(
      async () => {
        expect(projectLockQueueDepth(repo)).toBe(2);
        await Promise.resolve();
      },
      { timeout: 2_000 }
    );

    release();
    await turn;
    const res = await post;

    expect(res.status).toBe(200);
    expect(res.body.moved).toHaveLength(1);
    expect(res.body.status.counts.adoptable).toBe(0);
  });

  it('SK-16: records a Claude-shaped skill instead of moving it when the caller says claude-only', async () => {
    // The second verb on the same route, and the manifest entry it writes is a
    // SENTENCE (S18) rather than a code, because a person reads it in a file a
    // year later. Seeded defect: ignore `claudeOnly` and the skill moves —
    // handing a Claude-Code-only skill to five tools that cannot run it.
    const repo = stageAdoptProject('adopt-claude-only');

    const res = await adoptSkill(repo, 'release-notes', true);

    expect(res.status).toBe(200);
    expect(res.body.moved).toEqual([]);
    expect(res.body.declared).toEqual([
      {
        name: 'release-notes',
        path: '.claude/skills/release-notes',
        reason: 'Kept in Claude Code on purpose.',
      },
    ]);
    expect(existsSync(join(repo, '.claude', 'skills', 'release-notes', 'SKILL.md'))).toBe(true);
    const manifest = JSON.parse(
      readFileSync(join(repo, '.agents', 'harness.manifest.json'), 'utf8')
    );
    expect(manifest.claudeOnlySkills).toHaveLength(1);
  });
});
