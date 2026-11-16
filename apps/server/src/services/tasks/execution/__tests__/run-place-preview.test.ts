/**
 * Where a parked schedule's runs would stand, as its approval card says it
 * (DOR-4067, design pass row 3), checked against where the run really stands.
 *
 * Every case runs the run's own path, `chainRunPlacement` then
 * `guardRunPlacement` (what `TaskSchedulerService.resolveRunPlacement` calls),
 * and the card's, on the same collaborators, and asserts they agree. Real
 * folders in a fixture home with a dummy value only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { Task, TaskRunPlace } from '@dorkos/shared/types';
import type { Workspace } from '@dorkos/shared/workspace';
import { setAgentHomeRegistry } from '../../../core/agent-identity/index.js';
import {
  sessionCwdDeps,
  type ResolveSessionCwdDeps,
} from '../../../workspace/resolve-session-cwd.js';
import { SCHEDULED_RUNS_DIR, guardRunPlacement } from '../run-place-guard.js';
import { chainRunPlacement } from '../run-placement.js';
import { previewRunPlace, withTaskRunPlace } from '../run-place-preview.js';

let above: string;
let home: string;
let dork: string;
let agent: string;
let other: string;
let checkout: string;
let elsewhere: string;

beforeEach(() => {
  above = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dor4067-where-')));
  home = path.join(above, 'home');
  dork = path.join(home, '.dork');
  agent = path.join(home, 'agents', 'quill');
  other = path.join(home, 'agents', 'atlas');
  checkout = path.join(dork, 'workspaces', 'quill-copy');
  elsewhere = path.join(home, 'projects', 'site');
  for (const dir of [dork, agent, other, checkout, elsewhere])
    fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dork, 'host.key'), 'TOKEN=dor-4067-dummy-canary');
  vi.stubEnv('HOME', home);
  vi.stubEnv('DORK_HOME', dork);
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(above, 'claude-fixture'));
  const homes = [agent, other];
  setAgentHomeRegistry({
    isRegisteredHome: (dir) => homes.includes(dir),
    listRegisteredHomes: () => homes,
    managedWorkspaceOwner: (dir) => (dir === checkout ? agent : null),
    roomsDir: path.join(dork, 'rooms'),
  });
});

afterEach(() => {
  setAgentHomeRegistry(undefined);
  vi.unstubAllEnvs();
  fs.rmSync(above, { recursive: true, force: true });
});

const TASK = { id: 't1', agentId: 'quill' };
const NO_AGENT = { id: 't2', agentId: null };

/** A mesh that knows one agent, `quill`, at `folder`. */
function meshWith(folder: string | undefined) {
  return { getProjectPath: (id: string) => (id === 'quill' ? folder : undefined) };
}

/** The cwd chain's collaborators for one case; the same set feeds the run and the card. */
function chainDeps(opts: {
  mode?: 'home' | 'managed' | 'none';
  defaultCwd?: string;
  ready?: boolean;
  boundaryRefuses?: boolean;
}): ResolveSessionCwdDeps {
  return sessionCwdDeps({
    readManifest: async () =>
      opts.mode
        ? ({
            name: 'quill',
            workspace:
              opts.mode === 'managed' ? { mode: 'managed', source: agent } : { mode: opts.mode },
          } as unknown as AgentManifest)
        : null,
    ensureWorkspace: async () => {
      // A checkout not made yet waits on a person's card, as a real run's does.
      if (!opts.ready) throw new Error('waits on a person');
      return { id: 'ws-1', path: checkout } as Workspace;
    },
    validateAgentHome: async (dir) => {
      if (opts.boundaryRefuses) throw new Error('outside the boundary');
      return dir;
    },
    validateManagedCheckout: async (dir) => dir,
    canonicalize: async (dir) => dir,
    defaultCwd: opts.defaultCwd ?? elsewhere,
  });
}

/** Where the run really stands, or `refused` when it would not start. */
async function runFolder(
  task: Pick<Task, 'id' | 'agentId'>,
  mesh: ReturnType<typeof meshWith>,
  cwdDeps: ResolveSessionCwdDeps,
  serverCwd: string
): Promise<string> {
  try {
    const chained = await chainRunPlacement(task, mesh, { cwdDeps, serverCwd, log: false });
    return guardRunPlacement(chained).cwd;
  } catch {
    return 'refused';
  }
}

/** The card's answer and the run's folder, side by side. */
async function both(
  task: Pick<Task, 'id' | 'agentId'>,
  mesh: ReturnType<typeof meshWith>,
  cwdDeps: ResolveSessionCwdDeps,
  serverCwd = home
): Promise<{ card: TaskRunPlace | undefined; run: string }> {
  const card = await previewRunPlace(task, mesh, {
    cwdDeps: () => cwdDeps,
    serverCwd: () => serverCwd,
  });
  return { card, run: await runFolder(task, mesh, cwdDeps, serverCwd) };
}

/** The card names the folder the run stands in, or says nothing for a run that won't start. */
function expectAgree({ card, run }: { card: TaskRunPlace | undefined; run: string }) {
  if (card === undefined) return expect(run).toBe('refused');
  if (card.kind === 'private')
    return expect(path.dirname(run)).toBe(path.join(dork, SCHEDULED_RUNS_DIR));
  if (card.kind === 'agent_checkout') return expect(run).toBe(checkout);
  return expect(run).toBe(card.path);
}

describe("an agent's parked schedule says where the run stands", () => {
  it.each([
    ['the default binding', { mode: 'home' as const }, () => ({ kind: 'agent', path: agent })],
    ['no readable manifest', {}, () => ({ kind: 'agent', path: agent })],
    [
      'a managed binding with a ready checkout',
      { mode: 'managed' as const, ready: true },
      () => ({ kind: 'agent_checkout' }),
    ],
    [
      'a managed binding whose checkout waits on a person',
      { mode: 'managed' as const, ready: false },
      () => ({ kind: 'agent', path: agent }),
    ],
    [
      'a `none` binding whose default is home, which the guard moves',
      { mode: 'none' as const, defaultCwd: '<home>' },
      () => ({ kind: 'agent', path: agent }),
    ],
    [
      'a `none` binding whose default the guard keeps',
      { mode: 'none' as const },
      () => ({ kind: 'folder', path: elsewhere }),
    ],
    [
      'a home the boundary refuses, falling to the default',
      { mode: 'home' as const, boundaryRefuses: true },
      () => ({ kind: 'folder', path: elsewhere }),
    ],
    [
      "a `none` binding whose default is another agent's folder, which the desk guard refuses",
      { mode: 'none' as const, defaultCwd: '<other>' },
      () => undefined,
    ],
  ])('%s', async (_name, caseOpts, expected) => {
    const opts: Parameters<typeof chainDeps>[0] = caseOpts;
    const defaultCwd =
      opts.defaultCwd === '<home>' ? home : opts.defaultCwd === '<other>' ? other : undefined;
    const result = await both(
      TASK,
      meshWith(agent),
      chainDeps({ ...opts, ...(defaultCwd !== undefined && { defaultCwd }) })
    );
    expect(result.card).toEqual(expected());
    expectAgree(result);
  });

  it('claims nothing for an agent the registry no longer holds', async () => {
    const result = await both(TASK, meshWith(undefined), chainDeps({}));
    expect(result.card).toBeUndefined();
    expectAgree(result);
  });

  it('claims nothing when its own folder is the data folder, where no run may start', async () => {
    const result = await both(TASK, meshWith(dork), chainDeps({}));
    expect(result.card).toBeUndefined();
    expectAgree(result);
  });
});

describe('a parked schedule with no agent says where the run stands', () => {
  it.each([
    ['the home folder', () => home],
    ['a folder above it', () => above],
    ['the data folder', () => dork],
  ])('a fresh private folder when the server stands in %s', async (_name, cwd) => {
    const result = await both(NO_AGENT, meshWith(agent), chainDeps({}), cwd());
    expect(result.card).toEqual({ kind: 'private' });
    expectAgree(result);
  });

  it("the server's folder when the guard keeps it", async () => {
    const result = await both(NO_AGENT, meshWith(agent), chainDeps({}), elsewhere);
    expect(result.card).toEqual({ kind: 'folder', path: elsewhere });
    expectAgree(result);
  });

  it('makes no run folder just to answer', async () => {
    await previewRunPlace(NO_AGENT, meshWith(agent), {
      cwdDeps: () => chainDeps({}),
      serverCwd: () => home,
    });
    expect(fs.existsSync(path.join(dork, SCHEDULED_RUNS_DIR))).toBe(false);
  });
});

describe('withTaskRunPlace', () => {
  const parked = { id: 't1', agentId: 'quill', status: 'pending_approval' } as Task;
  const deps = { cwdDeps: () => chainDeps({ mode: 'home' }), serverCwd: () => home };

  it('stamps a parked schedule', async () => {
    const task = await withTaskRunPlace(parked, meshWith(agent), deps);
    expect(task.runPlace).toEqual({ kind: 'agent', path: agent });
  });

  it('leaves every other schedule alone, since only the approval card reads it', async () => {
    const active = { ...parked, status: 'active' } as Task;
    expect(await withTaskRunPlace(active, meshWith(agent), deps)).toBe(active);
  });

  it('leaves the field off when no run could start', async () => {
    const task = await withTaskRunPlace(parked, meshWith(dork), deps);
    expect(task).not.toHaveProperty('runPlace');
  });
});
