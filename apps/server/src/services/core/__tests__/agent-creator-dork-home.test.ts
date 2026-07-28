/**
 * Where a new agent lands when nobody has configured a directory (DOR-662).
 *
 * **This file deliberately mocks neither `lib/boundary.js` nor
 * `lib/agents-home.js`.** Every other `createAgentWorkspace` test stubs
 * `expandTilde` into an identity function, which means the real path resolution
 * — the thing that had the bug — never runs in them. The escape they cannot see
 * is this: the shipped default `agents.defaultDirectory` is the string
 * `~/.dork/agents`, and expanding that against the operator's home ignores
 * `DORK_HOME`, so creating an agent from a dev tree wrote into the operator's
 * live `~/.dork/agents`.
 *
 * The run is sealed inside one temp tree. `DORK_HOME` points at
 * `<tmp>/dork-home`, `HOME` points at `<tmp>/fake-home` (Node's `os.homedir()`
 * honours `$HOME` on POSIX, so the escape lands there rather than on the
 * operator's real disk), and the boundary root is the temp tree itself — wide
 * enough that BOTH destinations pass the boundary check, so the test measures
 * where the path resolves and not which validator refuses it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const mockConfigGet = vi.fn();
const mockConfigSet = vi.fn();
vi.mock('../config-manager.js', () => ({
  configManager: {
    get: (...args: unknown[]) => mockConfigGet(...args),
    set: (...args: unknown[]) => mockConfigSet(...args),
  },
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { createAgentWorkspace } from '../agent-creator.js';
import { initBoundary } from '../../../lib/boundary.js';
import { resolveAgentsDirectory, resolveAgentsHome } from '../../../lib/agents-home.js';

/** The string DorkOS ships in `agents.defaultDirectory`. */
const SHIPPED_DEFAULT = '~/.dork/agents';

let tmpRoot: string;
let dorkHome: string;
let fakeHome: string;
let realHome: string | undefined;
let realDorkHome: string | undefined;

/** Whether anything exists at `p`. */
async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  // realpath so the boundary's own symlink resolution (macOS /var → /private/var)
  // cannot make a contained path look escaped.
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-agents-home-')));
  dorkHome = path.join(tmpRoot, 'dork-home');
  fakeHome = path.join(tmpRoot, 'fake-home');
  await fs.mkdir(dorkHome);
  await fs.mkdir(fakeHome);

  realHome = process.env.HOME;
  realDorkHome = process.env.DORK_HOME;
  process.env.HOME = fakeHome;
  process.env.DORK_HOME = dorkHome;

  // Boundary spans the whole temp tree, so neither destination is refused.
  await initBoundary(tmpRoot);

  mockConfigGet.mockReturnValue({
    defaultDirectory: SHIPPED_DEFAULT,
    defaultAgent: 'nobody',
  });
  mockConfigSet.mockImplementation(() => undefined);
});

afterEach(async () => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (realDorkHome === undefined) delete process.env.DORK_HOME;
  else process.env.DORK_HOME = realDorkHome;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('resolveAgentsDirectory', () => {
  it('resolves the shipped default against DORK_HOME, not the home directory', () => {
    expect(resolveAgentsDirectory(SHIPPED_DEFAULT)).toBe(path.join(dorkHome, 'agents'));
    expect(resolveAgentsHome()).toBe(path.join(dorkHome, 'agents'));
  });

  it('resolves an absent or blank value to the same place', () => {
    expect(resolveAgentsDirectory(undefined)).toBe(path.join(dorkHome, 'agents'));
    expect(resolveAgentsDirectory('   ')).toBe(path.join(dorkHome, 'agents'));
  });

  it('still gives a person their own home for a directory they chose', () => {
    expect(resolveAgentsDirectory('~/work/agents')).toBe(path.join(fakeHome, 'work', 'agents'));
    expect(resolveAgentsDirectory('~')).toBe(fakeHome);
  });

  it('leaves an absolute configured directory exactly as configured', () => {
    const chosen = path.join(tmpRoot, 'somewhere-else');
    expect(resolveAgentsDirectory(chosen)).toBe(chosen);
  });
});

describe('createAgentWorkspace with the shipped default directory', () => {
  it('creates the agent under DORK_HOME and never touches the home directory', async () => {
    const result = await createAgentWorkspace({ name: 'sandbox-agent' });

    const expected = path.join(dorkHome, 'agents', 'sandbox-agent');
    expect(result.path).toBe(expected);
    expect(await exists(path.join(expected, '.dork', 'agent.json'))).toBe(true);

    // The escape this test exists for: nothing at all appeared under the home
    // directory, not even the `.dork` parent the old resolution would have made.
    expect(await exists(path.join(fakeHome, '.dork'))).toBe(false);
    expect(await fs.readdir(fakeHome)).toEqual([]);
  });

  it('honours a directory the person configured, tilde and all', async () => {
    mockConfigGet.mockReturnValue({
      defaultDirectory: '~/my-agents',
      defaultAgent: 'nobody',
    });

    const result = await createAgentWorkspace({ name: 'chosen-place' });

    expect(result.path).toBe(path.join(fakeHome, 'my-agents', 'chosen-place'));
    expect(await exists(path.join(dorkHome, 'agents'))).toBe(false);
  });
});
