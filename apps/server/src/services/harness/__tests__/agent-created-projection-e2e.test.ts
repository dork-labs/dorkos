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
vi.mock('../../core/config-manager.js', () => ({
  configManager: { get: (...args: unknown[]) => mockConfigGet(...args) },
}));

import { initBoundary } from '../../../lib/boundary.js';
import { createAgentsRouter } from '../../../routes/agents.js';
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
  mockConfigGet.mockImplementation((key: unknown) =>
    key === 'runtimes' ? { default: 'claude-code' } : { autoSync: true }
  );
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

  it('TR-03: a created agent is left to the pipeline that is building it', async () => {
    // Seeded defect: drop the `origin === 'created'` guard and this repo — which
    // is what `createAgentWorkspace` has scaffolded by the time it notifies —
    // gets a manifest written from DorkOS's OWN pointer files, so `.claude/`,
    // `GEMINI.md` and the Copilot file read as four harnesses somebody uses.
    // The create pipeline means Claude Code alone, with package hooks denied.
    const repo = stageOpenCodeRepo('created');
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'CLAUDE.md'), '@../AGENTS.md\n');
    writeFileSync(join(repo, 'GEMINI.md'), '# pointer\n');

    await notifyAgentCreated({ id: 'AGENT2', name: 'lemons', path: repo, origin: 'created' });

    expect(existsSync(join(repo, '.agents', 'harness.manifest.json'))).toBe(false);
  });

  it('TR-03: POST /api/agents writes no manifest into the folder it registers', async () => {
    // The route half of the case above: it declares `origin: 'created'`, so the
    // trigger stands down there too. Driven through the real router so the seam
    // it notifies is the production one, not a call written in this file.
    const repo = stageOpenCodeRepo('route');

    const res = await request(testServer)
      .post('/api/agents')
      .send({ path: repo, name: 'route-agent', runtime: 'claude-code' });

    expect(res.status).toBe(201);
    expect(existsSync(join(repo, '.agents', 'harness.manifest.json'))).toBe(false);
    expect(existsSync(join(repo, '.claude'))).toBe(false);
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
