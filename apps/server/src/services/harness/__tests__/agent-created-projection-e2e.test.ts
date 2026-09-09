/**
 * @vitest-environment node
 *
 * The agent-created projection against a REAL tree, from the seam every arrival
 * goes through (DOR-1901, contract TR-03 / J-03).
 *
 * `project-on-agent-created.test.ts` beside this one stubs the engine and holds
 * the trigger's SHAPE — lock, sweep, refusals. This one stubs nothing below the
 * seam: a real staged repository, the real boundary module, the real projection
 * engine, and the files it leaves on disk. Together they answer the two
 * questions that suite cannot: whether a projection actually lands, and whether
 * `notifyAgentCreated` reaches it at all.
 *
 * The seeded defects each case reds on are named at the case.
 *
 * **What this cannot see, and what covers it:** the listener registered here is
 * the one `index.ts` registers, written out again. That file boots a whole
 * server and no test constructs it, so the last case reads its source instead
 * and fails if the call is gone — measured: replacing `index.ts`'s
 * `runAgentCreatedProjection` call with a no-op left 130 files / 2373 tests
 * green before it existed.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
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
import path, { join } from 'node:path';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';

vi.mock('../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const mockConfigGet = vi.fn();
const mockConfigSet = vi.fn();
vi.mock('../../core/config-manager.js', () => ({
  configManager: {
    get: (...args: unknown[]) => mockConfigGet(...args),
    // `createAgentWorkspace` writes the default-agent setting when there is
    // none; a stub without it fails the whole creation inside its own catch.
    set: (...args: unknown[]) => mockConfigSet(...args),
  },
}));

import { initBoundary } from '../../../lib/boundary.js';
import { createAgentsRouter } from '../../../routes/agents.js';
import { createAgentWorkspace } from '../../core/agent-creator.js';
import { notifyAgentCreated, setOnAgentCreated } from '../../core/agent-created-hook.js';
import { runAgentCreatedProjection } from '../project-on-agent-created.js';

/** The repo root, six levels above this file. */
const ROOT = path.resolve(import.meta.dirname, '../../../../../..');

let boundaryRoot = '';
let dorkHome = '';
const staged: string[] = [];

const app = express();
app.use(express.json());
app.use('/api/agents', createAgentsRouter());
const testServer = listeningServer(app);

beforeAll(async () => {
  boundaryRoot = realpathSync(mkdtempSync(join(tmpdir(), 'agent-projection-boundary-')));
  dorkHome = realpathSync(mkdtempSync(join(tmpdir(), 'agent-projection-home-')));
  staged.push(boundaryRoot, dorkHome);
  await initBoundary(boundaryRoot);
  vi.stubEnv('DORK_HOME', dorkHome);
});

afterAll(() => {
  vi.unstubAllEnvs();
  setOnAgentCreated(null);
  for (const dir of staged.splice(0)) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  mockConfigGet.mockImplementation((key: unknown) => {
    if (key === 'runtimes') return { default: 'claude-code' };
    // `createAgentWorkspace` reads this to place a workspace with no directory
    // override; every case here names one, so it only has to be a shape.
    if (key === 'agents') return { defaultDirectory: join(dorkHome, 'agents') };
    return { autoSync: true };
  });
  // The reaction `index.ts` registers for this concern, written out again — the
  // last case is what keeps the two in step.
  setOnAgentCreated(async (agent) => {
    await runAgentCreatedProjection(agent, { dorkHome });
  });
});

afterEach(() => setOnAgentCreated(null));

/**
 * A repository somebody already works in: their own `AGENTS.md`, a skill where
 * OpenCode reads it, and no `.claude/` anywhere. The tree J-03 is about.
 */
function stageOpenCodeRepo(tag: string): string {
  const repo = mkdtempSync(join(boundaryRoot, `${tag}-`));
  staged.push(repo);
  mkdirSync(join(repo, '.opencode', 'skills', 'x'), { recursive: true });
  writeFileSync(join(repo, '.opencode', 'skills', 'x', 'SKILL.md'), '# x\n');
  writeFileSync(join(repo, 'AGENTS.md'), '# House rules\n\nRun the linter.\n');
  return repo;
}

/**
 * A workspace the create pipeline built at a directory the caller named, with a
 * hook already in its `.claude/settings.json`.
 *
 * The directory override is a first-class affordance, and it is what makes the
 * race visible: by the time the pipeline notifies, it has scaffolded `AGENTS.md`
 * and the per-harness pointers into this folder, so detection run against it
 * answers with DorkOS's own files.
 */
async function createPipelineWorkspace(tag: string): Promise<string> {
  const workspace = join(boundaryRoot, `pipeline-${tag}`);
  mkdirSync(join(workspace, '.claude'), { recursive: true });
  staged.push(workspace);
  writeFileSync(
    join(workspace, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } })
  );
  await createAgentWorkspace({ name: `pipeline-${tag}`, directory: workspace });
  return workspace;
}

/** The manifest's `harnesses` list, read back off disk. */
function manifestHarnesses(repo: string): string[] {
  const raw = JSON.parse(readFileSync(join(repo, '.agents', 'harness.manifest.json'), 'utf8')) as {
    harnesses: string[];
  };
  return raw.harnesses;
}

describe('an agent pointed at a project, end to end', () => {
  it('J-03, IN-01, TR-11: a registered agent leaves a manifest and the pointer on disk', async () => {
    // Seeded defect: the whole of DOR-1901 — before it, this arrival reached no
    // projection at all and both assertions below found nothing.
    const repo = stageOpenCodeRepo('registered');

    await notifyAgentCreated({
      id: 'AGENT1',
      name: 'tangerines',
      path: repo,
      origin: 'registered',
    });

    // Detection's own answer, then the one the folder could not show.
    expect(manifestHarnesses(repo)).toEqual(['codex', 'opencode', 'claude-code']);
    // A pointer, not a copy: their AGENTS.md stays the one file they edit.
    expect(readFileSync(join(repo, '.claude', 'CLAUDE.md'), 'utf8')).toBe('@../AGENTS.md\n');
  });

  it('TR-03: the create pipeline keeps its workspace Claude-Code-only', async () => {
    // The race, run for real. `createAgentWorkspace` scaffolds `AGENTS.md` and
    // the per-harness pointers, notifies this seam, and only THEN projects the
    // workspace — Claude Code alone, package hooks denied. Both scaffolds are
    // write-if-absent, so a second projector reacting to that notify wins, and
    // the manifest it writes is derived from DorkOS's own pointer files.
    //
    // Seeded defect: drop `workspaceProjectedByPipeline` (at the notify, or the
    // guard that reads it) and this comes back
    // `['claude-code', 'codex', 'gemini', 'copilot']` — measured.
    const workspace = await createPipelineWorkspace('harness-set');

    // The pipeline's own pointers are all there, which is what would have made
    // detection answer four — so the assertion is about a real temptation.
    expect(existsSync(join(workspace, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(workspace, 'GEMINI.md'))).toBe(true);
    expect(existsSync(join(workspace, '.github', 'copilot-instructions.md'))).toBe(true);
    // And the manifest is the pipeline's, not detection's.
    expect(manifestHarnesses(workspace)).toEqual(['claude-code']);
  });

  it('TR-03, HK-08: and writes no hooks file out of that unattended pass', async () => {
    // Its own case rather than one more line in the one above, because it is
    // the half that makes this a hazard rather than a tidiness point — and an
    // assertion sitting behind a failing one is never reached on the red it
    // exists for. A codex-enabled manifest is what turns this pass into a
    // writer of shell commands: the workspace's `.claude/settings.json` carries
    // a `Stop` hook, and `.codex/hooks.json` is where it would land.
    const workspace = await createPipelineWorkspace('hooks');

    expect(readFileSync(join(workspace, '.claude', 'settings.json'), 'utf8')).toContain('echo hi');
    expect(existsSync(join(workspace, '.codex'))).toBe(false);
  });

  it('J-03, IN-01: POST /api/agents projects the folder a person named', async () => {
    // Not the pipeline: this route mints a manifest at a directory somebody
    // chose and scaffolds nothing else. It says `origin: 'created'` all the
    // same, so skipping on that string would skip the very journey J-03 is
    // about. Driven through the real router, so the seam it notifies is the
    // production one rather than a call written in this file.
    //
    // Seeded defect: guard on `origin === 'created'` instead of the pipeline
    // flag and both assertions below find nothing.
    const repo = stageOpenCodeRepo('route');

    const res = await request(testServer)
      .post('/api/agents')
      .send({ path: repo, name: 'route-agent', runtime: 'claude-code' });

    expect(res.status).toBe(201);
    expect(manifestHarnesses(repo)).toEqual(['codex', 'opencode', 'claude-code']);
    expect(readFileSync(join(repo, '.claude', 'CLAUDE.md'), 'utf8')).toBe('@../AGENTS.md\n');
  });

  it('TR-11: an agent home is left to its own pass, with nothing written', async () => {
    const home = join(dorkHome, 'agents', 'dorkbot');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'AGENTS.md'), '# dorkbot\n');

    await notifyAgentCreated({ id: 'AGENT3', name: 'dorkbot', path: home, origin: 'registered' });

    expect(existsSync(join(home, '.agents', 'harness.manifest.json'))).toBe(false);
  });

  it('TR-11: a directory outside the boundary is refused, with nothing written', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'agent-projection-outside-')));
    staged.push(outside);
    writeFileSync(join(outside, 'AGENTS.md'), '# not ours\n');

    await notifyAgentCreated({ id: 'AGENT4', name: 'stray', path: outside, origin: 'registered' });

    expect(existsSync(join(outside, '.agents', 'harness.manifest.json'))).toBe(false);
  });

  it('TR-03: index.ts still hands the seam to this trigger', () => {
    // The one production call site, and nothing else can see it: `index.ts`
    // builds a whole server, so no test constructs its listener. Replacing that
    // call with a no-op left 130 files / 2373 tests green — every case above
    // included, since they register the reaction themselves. This reads the
    // source, the way the projection seam guard beside it does.
    const source = readFileSync(join(ROOT, 'apps/server/src/index.ts'), 'utf8');
    const listener = source.slice(source.indexOf('setOnAgentCreated(async'));
    expect(listener).not.toBe('');
    expect(listener.slice(0, listener.indexOf('\n  });'))).toContain(
      'await runAgentCreatedProjection(agent, { dorkHome });'
    );
  });
});
