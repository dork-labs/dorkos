/**
 * `POST /api/harness/syncs` over HTTP, plus the adopt's login-on case: the pieces
 * that turn login on or read the shipped decisions reader, so the config store
 * and the session gate are stood in for from `harnessState`. Setup and why the
 * rest is real: `harness.fixtures.ts`.
 *
 * @module routes/__tests__/harness/harness.sync
 */
import { describe, expect, it, vi } from 'vitest';
// Computer-side code reads agent facts through the port, wired as boot does.
import '../../../services/core/agent-identity/__tests__/wire-test-facts.js';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import request from '@dorkos/test-utils/supertest';
import { diffSnapshots, snapshotTree } from '@dorkos/harness/journeys';
import { HarnessSyncResponseSchema } from '@dorkos/shared/harness-schemas';
import {
  projectLockQueueDepth,
  withProjectLock,
} from '../../../services/harness/project-with-consent.js';
import { recordProjectInstall } from '../../../services/marketplace/lib/project-install-index.js';
import { installFolderDigest } from '../../../services/marketplace/lib/install-digest.js';
import {
  NO_CHANGES,
  adoptSkill,
  allowEveryPackagesHooks,
  gateway,
  harnessState,
  paths,
  readStatus,
  stageAdoptProject,
  stageProject,
  stageSyncProject,
  stubConfigGet,
  syncProject,
  useHarnessRoutes,
  writeAt,
  writeManifest,
} from './harness.fixtures.js';

// The session gate is what puts the resolved user on the request; without this
// stand-in the login-on cases would only ever see the gate's own 401.
vi.mock('../../../services/core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/core/auth/session-gate.js')>()),
  decideSessionGate: async () => ({ allowed: true, user: harnessState.signedInUser }),
}));

// `resolveDecisionAuthority` asks whether login is on, and `mayAskAboutHooks`
// whether a package was turned down; the shipped reader reads the preset. Any
// other read or a write is a failure with a message.
vi.mock('../../../services/core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => stubConfigGet(key),
    set: (key: string) => {
      throw new Error(`the harness router wrote config.${key}; nothing here should write one`);
    },
  },
}));

const servers = useHarnessRoutes();

describe('POST /api/harness/syncs', () => {
  it('answers 409 conflict on a project with no manifest, and writes nothing', async () => {
    // Seeded defect: let `loadManifest` throw out of the seam and this reds with
    // a 500 and a stack in the log — for a project in a state the status model
    // has a name for and the page draws its own copy for. The snapshot is the
    // other half: a 409 that scaffolded a manifest on the way past would be
    // DOR-678 arriving through a different door.
    const repo = stageProject('sync-bare');
    writeAt(join(repo, 'README.md'), '# nothing set up here\n');
    const before = snapshotTree(repo);

    const res = await syncProject(repo);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('conflict');
    expect(res.body.detail).toContain('dorkos harness sync --fix');
    expect(diffSnapshots(before, snapshotTree(repo))).toEqual(NO_CHANGES);
  });

  it('VC-05: refuses a caller naming itself an agent, and answers the same call without one', async () => {
    // Seeded defect: drop the `resolveDecisionAuthority` bar and the first call
    // answers 200 — a write into somebody's project, including a sweep, made by
    // the thing the person is supposed to be deciding for. Both halves are here
    // because a bar that refused EVERYONE would pass the first assertion alone.
    const repo = stageSyncProject('sync-agent');

    const refused = await request(servers.testServer)
      .post('/api/harness/syncs')
      .set('X-DorkOS-Agent', 'some-agent-token')
      .send({ projectPath: repo });

    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('person_only');
    // The refusal is ahead of validation, so it is the same answer whatever was
    // sent: a caller that may not do this at all does not get to probe a schema.
    const probed = await request(servers.testServer)
      .post('/api/harness/syncs')
      .set('X-DorkOS-Agent', 'some-agent-token')
      .send({ projectPath: 42 });
    expect(probed.status).toBe(403);

    const allowed = await syncProject(repo);
    expect(allowed.status).toBe(200);
  });

  it('VC-05: refuses the caller holding an approval token, and a person’s own terminal passes', async () => {
    // The second half of the agent bar, and the reason it is
    // `resolveDecisionAuthority` rather than `trustedCaller`: whoever asked must
    // not answer, but a person's own terminal sends no cookie and must still
    // work (DOR-502). Seeded defect: swap in `trustedCaller` and the cookie-less
    // call below reds under login-on.
    const repo = stageSyncProject('sync-token');

    const refused = await request(servers.testServer)
      .post('/api/harness/syncs')
      .set('x-dorkos-approval', 'some-approval-token')
      .send({ projectPath: repo });

    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('person_only');
    expect((await syncProject(repo)).status).toBe(200);
  });

  it('VC-05, DOR-502: lets a person through under login-on when their proof is an API key', async () => {
    // Purpose: the OTHER posture, and the one that decides which predicate this
    // route reads. Seeded defect: swap `resolveDecisionAuthority` for
    // `trustedCaller` and this reds with a 403 — DOR-474 put a cookie
    // requirement inside `trustedCaller`, so a person driving their own
    // terminal with a per-user API key would be refused a sync of their own
    // project. Every other case in this file stays green through that swap,
    // which is why this one has to exist.
    const repo = stageSyncProject('sync-signed-in');
    harnessState.loginEnabled = true;
    harnessState.signedInUser = { userId: 'u1', credential: 'api-key' };

    expect((await syncProject(repo)).status).toBe(200);

    // And the bar is still a bar in that posture: an agent holding the same
    // key is refused, so this is not "login-on allows everybody".
    const asAgent = await request(servers.testServer)
      .post('/api/harness/syncs')
      .set('X-DorkOS-Agent', 'some-agent-token')
      .send({ projectPath: repo });
    expect(asAgent.status).toBe(403);
  });

  it('VC-05: refuses under login-on when nobody is signed in at all', async () => {
    // The fail-closed leaf: login is on, so proof is required, and this caller
    // has none. Seeded defect: read `allowed` off a resolver that defaults to
    // permissive when it cannot tell, and an unauthenticated caller syncs.
    const repo = stageSyncProject('sync-anonymous');
    harnessState.loginEnabled = true;

    expect((await syncProject(repo)).status).toBe(403);
  });

  it('answers 400 for a missing, blank or relative projectPath', async () => {
    // Seeded defect: drop the body schema and the `isAbsolute` refinement, and a
    // bare POST resolves `undefined` against the server's cwd — a sync, with a
    // sweep, into whatever repository the operator happened to start it in.
    expect((await request(servers.testServer).post('/api/harness/syncs')).status).toBe(400);
    expect((await syncProject('   ')).status).toBe(400);

    const relative = await syncProject('some/relative/project');
    expect(relative.status).toBe(400);
    expect(JSON.stringify(relative.body)).toContain('projectPath must be an absolute path');
  });

  it('TR-08: repairs a link somebody deleted, and the RETURNED status is clean', async () => {
    // Seeded defect: return the status read BEFORE the apply and this reds — the
    // page would draw "some agent files are out of date" over a tree the click
    // had just made current, and the banner would never clear.
    const repo = stageSyncProject('sync-repair');
    expect((await syncProject(repo)).status).toBe(200);

    const link = join(repo, '.claude', 'skills', 'alpha');
    expect(existsSync(link)).toBe(true);
    rmSync(link, { recursive: true, force: true });
    // The read agrees something is wrong before the click, so the case cannot
    // pass by nothing ever having been broken.
    expect((await readStatus(repo)).body.clean).toBe(false);

    const res = await syncProject(repo);

    expect(res.status).toBe(200);
    const parsed = HarnessSyncResponseSchema.safeParse(res.body);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(res.body.status.clean).toBe(true);
    expect(res.body.status.counts.drifted).toBe(0);
    expect(res.body.applied).toBeGreaterThan(0);
    expect(existsSync(link)).toBe(true);
  });

  it('TR-11: the RETURNED status names the tool DorkOS runs, and the manifest is untouched', async () => {
    // The sync's own half of DOR-1901's wiring. `GET /status` is covered above;
    // this route builds a SECOND status, inside the lock, after its apply — and
    // the two have to answer the same question about the same repo or the page
    // draws one thing before the click and another after it.
    //
    // Seeded defect: drop `dorkosHarness: ours` from the recomputed
    // `buildHarnessStatus`, or from the `projectWithConsent` call that shares
    // the turn with it, and `notEnabled` comes back empty. Measured: dropping
    // either left 143 files / 2529 tests green before this case existed.
    //
    // The manifest deliberately omits `claude-code` and the tree has no
    // `.claude/` of its own until the sync writes one, so a footprint cannot
    // account for the entry.
    const repo = stageProject('sync-dorkos-runtime');
    writeManifest(repo, ['codex', 'opencode']);
    writeAt(join(repo, 'AGENTS.md'), '# House rules\n');
    const manifestPath = join(repo, '.agents', 'harness.manifest.json');
    const manifestBefore = readFileSync(manifestPath, 'utf8');

    const res = await syncProject(repo);

    expect(res.status).toBe(200);
    expect(res.body.status.notEnabled).toEqual([{ harness: 'claude-code', why: 'dorkos-runtime' }]);
    // A notice, never a repair: `--enable` is the only thing that writes this
    // file, and it is committed and shared with everybody on the project
    // (ADR-302). Byte equality rather than "it still parses the same", because
    // a re-serialized manifest with somebody's spacing rewritten is exactly the
    // harm that rule names.
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
  });

  it('AP-07: sweeps an uninstalled package’s projections and nothing else, and names every path', async () => {
    // Seeded defect: pass `sweepOrphans: false` and the swept paths survive —
    // `swept` is empty, the tree diff still names them as present, and the
    // banner the person just clicked is still there afterwards, for ever.
    const repo = stageSyncProject('sync-sweep', { plugin: true });
    allowEveryPackagesHooks(repo);
    expect((await syncProject(repo)).status).toBe(200);

    const projected = snapshotTree(repo);
    rmSync(join(repo, '.dork', 'plugins', 'acme'), { recursive: true, force: true });

    const res = await syncProject(repo);

    expect(res.status).toBe(200);
    expect([...res.body.swept].sort()).toEqual([
      '.agents/skills/acme__greet',
      '.claude/commands/acme/.gitignore',
      '.claude/commands/acme/hello.md',
      '.claude/settings.local.json',
      '.claude/skills/acme__greet',
      '.codex/hooks.json',
      '.codex/hooks.json.dorkos-generated',
      '.opencode/commands/.gitignore',
      '.opencode/commands/acme-hello.md',
    ]);

    // The exact tree diff, both directions: what went is what `swept` named,
    // the plugin's own directory the test removed, and nothing else. The
    // authored skill and its links are untouched.
    //
    // Two paths are named here that `swept` does not, and both are deliberate.
    // `.claude/settings.local.json` is in `swept` and does NOT go — only the
    // hook groups DorkOS merged into it do, which is what its reason says. And
    // `.claude/commands/acme` is the wrapper DIRECTORY the sweep tidies away
    // once it is empty: the engine reports the FILES it removes, because a
    // directory that only existed to hold them is bookkeeping.
    const after = snapshotTree(repo);
    const diff = diffSnapshots(projected, after);
    expect(diff.added).toEqual([]);
    expect(diff.removed.filter((p: string) => !p.startsWith('.dork/plugins/acme')).sort()).toEqual(
      [
        ...[...res.body.swept].filter((p: string) => p !== '.claude/settings.local.json'),
        '.claude/commands/acme',
      ].sort()
    );
    // The one path in the list that is NOT a deletion kept its promise.
    expect(existsSync(join(repo, '.claude', 'settings.local.json'))).toBe(true);
    expect(readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8')).not.toContain(
      'echo acme'
    );
    expect(existsSync(join(repo, '.claude', 'skills', 'alpha'))).toBe(true);
  });

  it('AP-07, VC-01: the GET’s sweepPreview is exactly the next POST’s swept, on the ten-path tree', async () => {
    // Seeded defect: revert Slice 2b's union and the preview is 1 path against a
    // sweep of 10 — a person told one file is going and nine more taken. The
    // count is asserted first, because empty-equals-empty satisfies set equality.
    const repo = stageSyncProject('sync-preview', { plugin: true });
    allowEveryPackagesHooks(repo);
    expect((await syncProject(repo)).status).toBe(200);

    rmSync(join(repo, '.agents', 'skills', 'alpha'), { recursive: true, force: true });
    rmSync(join(repo, '.dork', 'plugins', 'acme'), { recursive: true, force: true });

    const preview = await readStatus(repo);
    expect(preview.body.sweepPreview).toHaveLength(10);

    const res = await syncProject(repo);

    expect(res.body.swept).toHaveLength(10);
    expect([...res.body.swept].sort()).toEqual([...preview.body.sweepPreview].sort());
  });

  it('AP-07, VC-01: says WHY each path goes, before the click and after it (DOR-1906)', async () => {
    // Seeded defect: send the bare paths and drop `removals`, and the page has a
    // list of ten files it can only introduce with one heading — which is wrong
    // for at least five of them, and dangerously wrong for the settings file,
    // which is not deleted at all.
    const repo = stageSyncProject('sync-reasons', { plugin: true });
    allowEveryPackagesHooks(repo);
    expect((await syncProject(repo)).status).toBe(200);
    rmSync(join(repo, '.agents', 'skills', 'alpha'), { recursive: true, force: true });
    rmSync(join(repo, '.dork', 'plugins', 'acme'), { recursive: true, force: true });

    const preview = await readStatus(repo);
    const previewReasons: Record<string, string> = Object.fromEntries(
      preview.body.removals.map((r: { path: string; reason: string }) => [r.path, r.reason])
    );

    expect(preview.body.removals.map((r: { path: string }) => r.path)).toEqual(
      preview.body.sweepPreview
    );
    expect(previewReasons['.claude/skills/alpha']).toBe('The skill this link pointed to is gone.');
    expect(previewReasons['.claude/skills/acme__greet']).toBe(
      'The package this skill came from is no longer installed here.'
    );
    expect(previewReasons['.codex/hooks.json']).toBe(
      'DorkOS wrote this, and no hooks project here any more.'
    );
    expect(previewReasons['.claude/settings.local.json']).toBe(
      'Only the hook entries DorkOS added go; your own settings stay.'
    );

    // And the receipt says the same thing about the same ten paths, so the
    // promise before the click and the list after it are one list.
    const res = await syncProject(repo);
    expect(
      Object.fromEntries(
        res.body.removals.map((r: { path: string; reason: string }) => [r.path, r.reason])
      )
    ).toEqual(previewReasons);
  });

  it('HK-11: leaves a hand-written .codex/hooks.json alone and reports it as a conflict', async () => {
    // Seeded defect: widen the sweep past sidecar-matched files and this reds
    // twice over — the file is gone, and the byte comparison names what was in
    // it. HK-11 was three hand-written hooks files deleted by a sweep with no
    // way to prove which generated files were its own.
    const repo = stageSyncProject('sync-handwritten', { plugin: true });
    allowEveryPackagesHooks(repo);
    const mine = join(repo, '.codex', 'hooks.json');
    // The shape Codex documents, which is also the shape the engine writes now —
    // so this is unambiguously somebody's own file rather than the engine's own
    // pre-sidecar output, which `generatedHookOutcome` migrates on purpose.
    const contents = JSON.stringify(
      { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } },
      null,
      2
    );
    writeAt(mine, contents);

    const res = await syncProject(repo);

    expect(res.status).toBe(200);
    expect(readFileSync(mine, 'utf8')).toBe(contents);
    expect(res.body.swept).not.toContain('.codex/hooks.json');
    expect(res.body.conflicts).toBeGreaterThan(0);
    expect(res.body.status.counts.conflicts).toBeGreaterThan(0);
  });

  it(
    'VC-02: raises one card per unapproved package and answers without waiting for it',
    { timeout: 4_000 },
    async () => {
      // Seeded defect: `await` the cards inside the route and this times out —
      // the gateway below never decides, exactly like a person who has not looked
      // at the screen yet, and the approval window is two hours. A button that
      // hangs on a modal is the shape being refused here.
      const repo = stageSyncProject('sync-card', { plugin: true });

      const res = await syncProject(repo);

      expect(res.status).toBe(200);
      expect(res.body.askedAbout).toEqual(['acme']);
      expect(gateway.requested).toEqual(['acme']);
      // The hooks are not installed while nobody has answered, and the status
      // says so rather than going quiet about it.
      expect(existsSync(join(repo, '.codex', 'hooks.json'))).toBe(false);
      expect(res.body.status.counts.pendingApproval).toBe(1);
      expect(res.body.status.pendingApproval[0].packageName).toBe('acme');
    }
  );

  it('on Full, a package DorkOS installed syncs its hooks with no card (DOR-3422)', async () => {
    // The live route's decisions carry the preset; QA found the shipped reader
    // left it out, so Full still carded through Sync now.
    const repo = stageSyncProject('sync-full-installed', { plugin: true });
    const plugin = join(repo, '.dork', 'plugins', 'acme');
    const folder = await installFolderDigest(plugin);
    if (folder.kind !== 'digest') throw new Error('the staged plugin did not digest');
    await recordProjectInstall(paths.dorkHome, {
      projectPath: repo,
      installRoot: plugin,
      name: 'acme',
      source: 'dork-labs/marketplace',
      installDigest: folder.digest,
    });
    harnessState.hookDecisions = { approved: [], refused: [], full: true };

    const res = await syncProject(repo);

    expect(res.status).toBe(200);
    expect(res.body.askedAbout).toEqual([]);
    expect(gateway.requested).toEqual([]);
    expect(readFileSync(join(repo, '.codex', 'hooks.json'), 'utf8')).toContain('echo acme');
    expect(res.body.status.counts.pendingApproval).toBe(0);
  });

  it(
    'on Full, a committed package whose hooks name no file is held back, with no row (DOR-3422)',
    { timeout: 4_000 },
    async () => {
      // No install record: a repository committed this folder. Its `echo` names
      // no file, so a yes could not say what it allows, and nobody is asked
      // (Security row 8). A package whose hooks run a file gets the quiet row
      // (`hook-full-preset.test.ts`).
      const repo = stageSyncProject('sync-full-committed', { plugin: true });
      harnessState.hookDecisions = { approved: [], refused: [], full: true };

      const res = await syncProject(repo);

      expect(res.status).toBe(200);
      expect(res.body.askedAbout).toEqual([]);
      expect(gateway.requested).toEqual([]);
      expect(existsSync(join(repo, '.codex', 'hooks.json'))).toBe(false);
    }
  );

  it.each([
    ['full', true],
    ['trusted', false],
  ] as const)(
    'through the shipped decisions reader, preset %s: Full is read off the store, nothing set by hand (QA, DOR-3422)',
    async (preset, runs) => {
      const repo = stageSyncProject(`sync-shipped-${preset}`, { plugin: true });
      const plugin = join(repo, '.dork', 'plugins', 'acme');
      const folder = await installFolderDigest(plugin);
      if (folder.kind !== 'digest') throw new Error('the staged plugin did not digest');
      await recordProjectInstall(paths.dorkHome, {
        projectPath: repo,
        installRoot: plugin,
        name: 'acme',
        source: 'dork-labs/marketplace',
        installDigest: folder.digest,
      });
      harnessState.storedPreset = preset;

      const res = await request(servers.shippedReaderServer)
        .post('/api/harness/syncs')
        .send({ projectPath: repo })
        .then((r) => r);

      expect(res.status).toBe(200);
      expect(res.body.askedAbout).toEqual(runs ? [] : ['acme']);
      expect(existsSync(join(repo, '.codex', 'hooks.json'))).toBe(runs);
    }
  );

  it('AP-10: queues behind a projection already running on that repository, then answers 200', async () => {
    // Seeded defect: drop `withProjectLock` and the POST applies into a tree
    // another writer is half-way through, then reads a status describing
    // neither. Asserted through the lock's own queue depth rather than a timer,
    // so the case cannot pass by being slow.
    const repo = stageSyncProject('sync-lock');
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const turn = withProjectLock(repo, () => held);

    const post = syncProject(repo);
    await vi.waitFor(
      async () => {
        // The response is checked first so a route that refused early fails with
        // ITS reason rather than with a queue depth nobody can read.
        expect(projectLockQueueDepth(repo)).toBe(2);
        await Promise.resolve();
      },
      { timeout: 2_000 }
    );

    release();
    await turn;
    const res = await post;

    expect(res.status).toBe(200);
    expect(res.body.status.state).toBe('ready');
    expect(res.body.status.clean).toBe(true);
  });
  it('VC-05, DOR-502: the adopt lets a person through under login-on when their proof is an API key', async () => {
    // The other posture, and the one that decides WHICH predicate this route
    // reads. Seeded defect: `trustedCaller` here reds this with a 403, because
    // DOR-474 put a cookie requirement inside it and a person driving their own
    // terminal sends none.
    const repo = stageAdoptProject('adopt-signed-in');
    harnessState.loginEnabled = true;
    harnessState.signedInUser = { userId: 'u1', credential: 'api-key' };

    expect((await adoptSkill(repo, 'release-notes')).status).toBe(200);
  });
});
