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
 * **No config store is opened, and the stand-in answers two keys only.** The
 * router takes its hook-decision reader as a dependency and this suite passes
 * its own; nothing here creates `config.json`, which the dork-home snapshot in
 * the first case is what proves.
 *
 * `configManager` still has to answer something, because two things reach it
 * that are not the router's dependency: `resolveDecisionAuthority` asks whether
 * login is on, and `mayAskAboutHooks` — inside the asking half the POST fires —
 * asks whether a package has already been turned down. So the stand-in answers
 * `auth` from {@link loginEnabled} and `harness` from the same decisions the
 * router was given, and **throws for every other key**, naming it: a route that
 * reached past its injected reader is a failure with a message rather than a
 * quiet pass. It writes nothing to disk, so the never-writes claim is unchanged.
 *
 * Left unmocked it is `undefined` here, which reads as "login is on and nobody
 * is signed in" — every sync would answer `403` for a reason that has nothing to
 * do with the bar under test, and the asking half would throw.
 *
 * **The fake `HookApprovalGateway` belongs to the POST.** The GET raises no
 * approval card and reaches no gateway; the sync does, and this file's one
 * never decides anything — which is how "the route answers without waiting for
 * a card" is a claim about the route rather than about how fast a fixture is.
 * There is still no `FakeAgentRuntime`: these routes touch no runtime, and
 * wiring one in would be a prop no test reads.
 *
 * Every case names the seeded defect that reds it: this route does not exist on
 * `main`, so "fails on main" is trivially true and proves nothing.
 *
 * @module routes/__tests__/harness
 */
import { describe, expect, it, afterEach, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { diffSnapshots, snapshotTree } from '@dorkos/harness/journeys';
import {
  HarnessStatusResponseSchema,
  HarnessSyncResponseSchema,
} from '@dorkos/shared/harness-schemas';
import { initBoundary } from '../../lib/boundary.js';
import { logger } from '../../lib/logger.js';
import type {
  ApprovalBinding,
  ApprovalConsumeResult,
  ApprovalRequestInput,
  ApprovalTicket,
} from '../../services/core/approvals/approval-service.js';
import { _internal as approvalInternal } from '../../services/harness/hook-approval.js';
import { hookApprovalEntry, type HookDecisions } from '../../services/harness/hook-consent.js';
import {
  projectLockQueueDepth,
  scanHookRequests,
  withProjectLock,
} from '../../services/harness/project-with-consent.js';
import { createHarnessRouter } from '../harness.js';

/** Nobody has decided anything — the shape every case here runs under. */
const NO_DECISIONS: HookDecisions = { approved: [], refused: [] };

/**
 * The decisions the router reads, swapped per case.
 *
 * A `let` rather than a constant because the router reads its dependency ONCE,
 * when it is built, and the sweep cases need a package's hooks to have been
 * allowed before they can produce the ten paths the spec measured. Reset after
 * every case, so one test's yes is never another's.
 */
let hookDecisions: HookDecisions = NO_DECISIONS;

/**
 * Whether DorkOS login is on, per case.
 *
 * `false` is the default posture and the one DOR-502 is about: a person's own
 * terminal sends no cookie and must still be able to sync. `true` is the
 * login-on posture, where proof is required and a per-user API key is proof —
 * which is exactly what `trustedCaller` would refuse and what makes the choice
 * of `resolveDecisionAuthority` a decision rather than a preference. Both
 * postures have a case below.
 */
let loginEnabled = false;

/** Stands in for `sessionGate`'s resolved user, when a case signs one in. */
let signedInUser: { userId: string; credential: 'cookie' | 'api-key' } | undefined;

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => {
      if (key === 'auth') return { enabled: loginEnabled };
      if (key === 'harness') {
        return { approvedHooks: hookDecisions.approved, refusedHooks: hookDecisions.refused };
      }
      throw new Error(`the harness router read config.${key} instead of its injected dependency`);
    },
    set: (key: string) => {
      throw new Error(`the harness router wrote config.${key}; nothing here should write one`);
    },
  },
}));

/**
 * An approval gateway that raises every card and decides none of them.
 *
 * That is the whole fixture: `askForHookProjection` polls `consume` until an
 * outcome that is not `pending` arrives or the ticket expires, so a gateway that
 * answers `pending` for ever is a person who has not looked at the screen. A
 * route that awaited its cards would therefore never answer, which is exactly
 * what the VC-02 case is for.
 */
const gateway = {
  /** Packages a card was raised for, in order. */
  requested: [] as string[],
  request(input: ApprovalRequestInput): ApprovalTicket {
    const summary = input.summary ?? '';
    // The card's summary names the package; the route's `askedAbout` is what is
    // really under test, so this only has to be enough to tell two apart.
    this.requested.push(summary.includes('acme') ? 'acme' : summary);
    return {
      approvalId: `approval-${this.requested.length}`,
      token: `token-${this.requested.length}`,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    } as ApprovalTicket;
  },
  consume(_token: string, _binding: ApprovalBinding): ApprovalConsumeResult {
    return { outcome: 'pending' } as ApprovalConsumeResult;
  },
};

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
/** A Claude root that does not exist — see {@link pinEmptyClaudeRoot}. */
let emptyClaudeRoot: string;

/** Temp directories to remove when the suite ends. */
const staged: string[] = [];

const app = express();
// The POST takes a JSON body, and Express parses none by default. The GET never
// needed this; without it `req.body` is undefined and every sync answers 400.
app.use(express.json());
// Stands in for `sessionGate`, which is what puts the resolved user on
// `res.locals` in the real server. Without it there is no way to ask what a
// signed-in operator gets, and the login-on cases would only ever see the
// nobody-is-signed-in answer.
app.use((_req, res, next) => {
  if (signedInUser !== undefined) res.locals.user = signedInUser;
  next();
});
const testServer = listeningServer(app);

/**
 * The message a broken dependency carries, with a path in it on purpose.
 *
 * The 500 case is about what does NOT come back, and a message a caller could
 * have guessed proves nothing: this one names a directory the request never
 * mentioned, so finding any of it in the body is unambiguous.
 */
const READ_FAILURE = new Error('config store unreadable at /Users/someone/private-notes/.dork');

/**
 * A second app whose hook-decision reader throws, so the 500 path has a way in.
 *
 * It is a second MOUNT rather than a mutable dependency because the route reads
 * `deps` once, when the router is built. Of the route's three 500 branches this
 * reaches one — the guarded `buildHarnessStatus` call, where the injected reader
 * runs. The other two are the non-`BoundaryError` throw out of the validator and
 * the non-ENOENT/EACCES throw out of `stat`, and neither is reachable through a
 * dependency: both take the real module. They are the same two lines of `catch`,
 * so one case is what there is to have.
 */
const failingApp = express();
const failingServer = listeningServer(failingApp);

beforeAll(async () => {
  boundaryRoot = realpathSync(mkdtempSync(join(tmpdir(), 'harness-route-boundary-')));
  dorkHome = realpathSync(mkdtempSync(join(tmpdir(), 'harness-route-home-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'harness-route-outside-')));
  staged.push(boundaryRoot, dorkHome, outside);
  await initBoundary(boundaryRoot);
  // `validateBoundaryOrDorkHome` resolves `{dorkHome}/agents` off this, and
  // caches by the raw value, so stubbing it here is enough.
  vi.stubEnv('DORK_HOME', dorkHome);
  emptyClaudeRoot = join(outside, 'claude-root-that-is-not-there');
  pinEmptyClaudeRoot();
  // ONE mount, and it has to stay one: Express serves the FIRST router matching
  // a path, so a second `app.use('/api/harness', …)` beside this one is dead
  // code that silently takes over every request. A merge left two here — one
  // with the fixed `NO_DECISIONS` reader and no gateway, one with both — and the
  // first won: the sync suite's package hooks were withheld on every run (six
  // swept paths instead of nine), `HK-11` found no conflict because nothing
  // wanted to write the hooks file, and `askedAbout` was empty because the route
  // had no gateway to ask through. `hookDecisions` starts as `NO_DECISIONS` and
  // `afterEach` puts it back, so the cases that want nobody to have decided
  // anything get exactly that from this one mount.
  app.use(
    '/api/harness',
    createHarnessRouter({
      dorkHome,
      readHookDecisions: () => hookDecisions,
      approvals: gateway,
      // The second config read on this path, injected for the same reason as
      // the first: this suite opens no config store at all, and the shipped
      // default reaches the running server's (DOR-1901).
      dorkosHarness: () => 'claude-code',
    })
  );
  failingApp.use(
    '/api/harness',
    createHarnessRouter({
      dorkHome,
      readHookDecisions: () => {
        throw READ_FAILURE;
      },
      dorkosHarness: () => 'claude-code',
    })
  );
});

afterAll(() => {
  vi.unstubAllEnvs();
  for (const dir of staged.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// The logger spy in the 500 case is the only mock here, and it has to come off
// before the next case: left installed, it would swallow a real failure's log.
// The consent state goes back too — a yes recorded for one project's package
// would otherwise decide for the next case's — and so does the open-card memory,
// which `mayAskAboutHooks` reads and which would stop the second card of a run.
afterEach(() => {
  vi.restoreAllMocks();
  // `restoreAllMocks` does not touch env stubs, and one case below repoints
  // `$CLAUDE_CONFIG_DIR` at a fixture root. Put it back rather than leave the
  // next case reading somebody else's fixture.
  pinEmptyClaudeRoot();
  hookDecisions = NO_DECISIONS;
  loginEnabled = false;
  signedInUser = undefined;
  gateway.requested = [];
  approvalInternal.forgetDecisions();
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

/**
 * Point `$CLAUDE_CONFIG_DIR` at a Claude root that does not exist.
 *
 * The route reports the plugins a person turned on in Claude Code, and it finds
 * that root the way a bare `claude` does — `$CLAUDE_CONFIG_DIR`, else
 * `~/.claude`. Unpinned, every case in this file would read the settings file of
 * whichever developer ran it, and the answers would depend on whose machine the
 * suite was on. An ABSENT directory rather than an empty one, because absent is
 * the case the reader is required to answer silently, so the default pin keeps
 * that promise under test on every run too.
 */
function pinEmptyClaudeRoot(): void {
  vi.stubEnv('CLAUDE_CONFIG_DIR', emptyClaudeRoot);
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
    // Every number here is knowable on this fixture, so every number is stated.
    // One skill in `.claude/skills`, which Claude Code reads where it stands and
    // Codex cannot see, plus the instruction row for the `AGENTS.md` that is not
    // there — two rows, and the skill is the adoptable one.
    expect(res.body.counts).toEqual({
      skills: 1,
      // No package installed for all projects on this fixture, so the global
      // half of the fold contributes nothing.
      globalSkills: 0,
      drifted: 0,
      conflicts: 0,
      orphans: 0,
      adoptable: 1,
      pendingApproval: 0,
    });
    expect(
      res.body.rows.map((r: { artifact: string; name: string; source?: string }) => [
        r.artifact,
        r.name,
        r.source,
      ])
    ).toEqual([
      ['skill', 'release', '.claude/skills/release'],
      ['instruction', 'AGENTS.md', 'AGENTS.md'],
    ]);
    expect(res.body.rows[0].provenance).toBe('harness-native');
    expect(res.body.rows[0].adoptable).toBe(true);
    expect(Object.keys(res.body.rows[0].cells)).toEqual(['claude-code', 'codex']);
    expect(res.body.projectLevel).toEqual([]);
    expect(res.body.sweepPreview).toEqual([]);
    expect(diffSnapshots(before, snapshotTree(repo))).toEqual(NO_CHANGES);
  });

  it('answers 400 for a relative projectPath rather than resolving it against the server cwd', async () => {
    // Seeded defect: drop the `isAbsolute` refinement and this reds with a 403,
    // because the path is then resolved against the RUNNER's cwd and lands
    // outside this suite's temp boundary. In production, where the server's cwd
    // is normally inside the boundary, the same defect answers 200 instead —
    // about a directory the caller never named, chosen by wherever the operator
    // happened to start the process. Neither answer is the request that was
    // made, which is why the refusal is up front rather than left to the
    // boundary to catch by luck.
    const res = await readStatus('some/relative/project');

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('projectPath must be an absolute path');
  });

  it('answers 500 with nothing of the failure in it when a dependency throws', async () => {
    // Seeded defect: echo `err.message` into the body — `{ error: toErrorMessage(err) }`
    // — and this reds. Every one of the eight cases above stays green through
    // that change, because none of them can reach the 500 path at all: the state
    // a person can act on is always a 200, so the only way in is a dependency
    // that breaks, and the only thing worth asserting about it is what does NOT
    // come back.
    const errors = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    const repo = stageProject('boom');
    writeManifest(repo, ['claude-code']);

    const res = await request(failingServer)
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
    const claudeRoot = mkdtempSync(join(outside, 'claude-root-'));
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
    const claudeRoot = mkdtempSync(join(outside, 'claude-broken-'));
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

/**
 * A project with one authored skill, and — when asked — one project-scoped
 * marketplace plugin shipping a skill, a command and a hook.
 *
 * Staged the way a person's tree really is rather than by hand-writing the
 * projected paths, so the fixture cannot drift away from what the engine
 * actually writes. It is the shape §2.2.1 of the spec measured: three harnesses
 * enabled, ten paths for a sweep to take once the skill is deleted and the
 * plugin uninstalled.
 */
function stageSyncProject(tag: string, opts: { plugin?: boolean } = {}): string {
  const repo = stageProject(tag);
  writeManifest(repo, ['claude-code', 'codex', 'opencode']);
  writeAt(
    join(repo, '.agents', 'skills', 'alpha', 'SKILL.md'),
    '---\nname: alpha\ndescription: The alpha skill\n---\n\n# alpha\n'
  );
  if (opts.plugin !== true) return repo;

  const plugin = join(repo, '.dork', 'plugins', 'acme');
  writeAt(
    join(plugin, '.dork', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'acme',
      version: '1.0.0',
      type: 'plugin',
      description: 'Acme test plugin',
      layers: ['skills', 'hooks', 'commands'],
    })
  );
  writeAt(
    join(plugin, 'skills', 'greet', 'SKILL.md'),
    '---\nname: greet\ndescription: The greet skill\n---\n\n# greet\n'
  );
  writeAt(join(plugin, 'commands', 'hello.md'), '---\ndescription: Say hello\n---\n\nSay hello.\n');
  writeAt(
    join(plugin, 'hooks', 'hooks.json'),
    JSON.stringify({ Stop: [{ hooks: [{ type: 'command', command: 'echo acme' }] }] })
  );
  return repo;
}

/**
 * Say yes, in advance, to every hook-declaring package in this project.
 *
 * Built from the production scanner and the production digest rather than from
 * a hand-written entry, so a change to what a decision BINDS reds the fixture
 * instead of quietly un-approving it. Without this the plugin's hooks stay
 * withheld, `.codex/hooks.json` is never written, and the ten-path sweep the
 * spec measured is a six-path one.
 */
function allowEveryPackagesHooks(repo: string): void {
  hookDecisions = {
    approved: scanHookRequests(repo, dorkHome).map(hookApprovalEntry),
    refused: [],
  };
}

/**
 * The sync, as the page makes it.
 *
 * The trailing `.then` is not decoration, and the read above it has one for the
 * same reason: supertest's request object is LAZY, and does not send until
 * something subscribes to it. The lock case holds the request while it asserts
 * about the queue — and without this it would be holding a request nobody had
 * made, waiting for a queue depth that could never rise.
 */
function syncProject(projectPath: string) {
  return request(testServer)
    .post('/api/harness/sync')
    .send({ projectPath })
    .then((res) => res);
}

describe('POST /api/harness/sync', () => {
  it('answers 409 harness_not_set_up on a project with no manifest, and writes nothing', async () => {
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
    expect(res.body.code).toBe('harness_not_set_up');
    expect(res.body.error).toContain('agent files');
    expect(res.body.message).toContain('dorkos harness sync --fix');
    expect(diffSnapshots(before, snapshotTree(repo))).toEqual(NO_CHANGES);
  });

  it('VC-05: refuses a caller naming itself an agent, and answers the same call without one', async () => {
    // Seeded defect: drop the `resolveDecisionAuthority` bar and the first call
    // answers 200 — a write into somebody's project, including a sweep, made by
    // the thing the person is supposed to be deciding for. Both halves are here
    // because a bar that refused EVERYONE would pass the first assertion alone.
    const repo = stageSyncProject('sync-agent');

    const refused = await request(testServer)
      .post('/api/harness/sync')
      .set('X-DorkOS-Agent', 'some-agent-token')
      .send({ projectPath: repo });

    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('operator_only_harness_sync');
    // The refusal is ahead of validation, so it is the same answer whatever was
    // sent: a caller that may not do this at all does not get to probe a schema.
    const probed = await request(testServer)
      .post('/api/harness/sync')
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

    const refused = await request(testServer)
      .post('/api/harness/sync')
      .set('x-dorkos-approval', 'some-approval-token')
      .send({ projectPath: repo });

    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('operator_only_harness_sync');
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
    loginEnabled = true;
    signedInUser = { userId: 'u1', credential: 'api-key' };

    expect((await syncProject(repo)).status).toBe(200);

    // And the bar is still a bar in that posture: an agent holding the same
    // key is refused, so this is not "login-on allows everybody".
    const asAgent = await request(testServer)
      .post('/api/harness/sync')
      .set('X-DorkOS-Agent', 'some-agent-token')
      .send({ projectPath: repo });
    expect(asAgent.status).toBe(403);
  });

  it('VC-05: refuses under login-on when nobody is signed in at all', async () => {
    // The fail-closed leaf: login is on, so proof is required, and this caller
    // has none. Seeded defect: read `allowed` off a resolver that defaults to
    // permissive when it cannot tell, and an unauthenticated caller syncs.
    const repo = stageSyncProject('sync-anonymous');
    loginEnabled = true;

    expect((await syncProject(repo)).status).toBe(403);
  });

  it('answers 400 for a missing, blank or relative projectPath', async () => {
    // Seeded defect: drop the body schema and the `isAbsolute` refinement, and a
    // bare POST resolves `undefined` against the server's cwd — a sync, with a
    // sweep, into whatever repository the operator happened to start it in.
    expect((await request(testServer).post('/api/harness/sync')).status).toBe(400);
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
});
