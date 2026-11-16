/**
 * Where a parked schedule's runs would stand, as its approval card says it
 * (DOR-4067, design pass row 3). Each case also runs the real guard, so the
 * card's answer and the run's folder are checked against each other. Real
 * folders in a fixture home with a dummy value only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { Task } from '@dorkos/shared/types';
import { SCHEDULED_RUNS_DIR, guardRunPlacement } from '../run-place-guard.js';
import { previewRunPlace, withTaskRunPlace } from '../run-place-preview.js';

let above: string;
let home: string;
let dork: string;
let agent: string;
let elsewhere: string;

beforeEach(() => {
  above = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dor4067-where-')));
  home = path.join(above, 'home');
  dork = path.join(home, '.dork');
  agent = path.join(home, 'agents', 'quill');
  elsewhere = path.join(home, 'projects', 'site');
  fs.mkdirSync(dork, { recursive: true });
  fs.mkdirSync(agent, { recursive: true });
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.writeFileSync(path.join(dork, 'host.key'), 'TOKEN=dor-4067-dummy-canary');
  vi.stubEnv('HOME', home);
  vi.stubEnv('DORK_HOME', dork);
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(above, 'claude-fixture'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(above, { recursive: true, force: true });
});

/** A mesh that knows one agent, `quill`, at `folder`. */
function meshWith(folder: string | undefined) {
  return { getProjectPath: (id: string) => (id === 'quill' ? folder : undefined) };
}

/** Injected collaborators: the server's folder, its default and the manifest's binding. */
function deps(opts: { serverCwd?: string; defaultCwd?: string; mode?: string }) {
  return {
    serverCwd: () => opts.serverCwd ?? home,
    defaultCwd: opts.defaultCwd ?? home,
    readManifest: async () =>
      opts.mode
        ? ({ workspace: { mode: opts.mode, source: agent } } as unknown as AgentManifest)
        : null,
  };
}

describe("an agent's parked schedule", () => {
  it("names the agent's own folder for the default binding", async () => {
    const place = await previewRunPlace({ agentId: 'quill' }, meshWith(agent), deps({}));
    expect(place).toEqual({ kind: 'agent', path: agent });
    expect(guardRunPlacement({ cwd: agent, agentPath: agent }).cwd).toBe(agent);
  });

  it("names the agent's own folder when its manifest has no binding to read", async () => {
    const place = await previewRunPlace({ agentId: 'quill' }, meshWith(agent), {
      ...deps({}),
      readManifest: async () => {
        throw new Error('unreadable');
      },
    });
    expect(place).toEqual({ kind: 'agent', path: agent });
  });

  it('says a private checkout for a managed binding, with no path to claim yet', async () => {
    const place = await previewRunPlace(
      { agentId: 'quill' },
      meshWith(agent),
      deps({ mode: 'managed' })
    );
    expect(place).toEqual({ kind: 'agent_checkout' });
  });

  it("names the agent's own folder when a `none` binding falls to home, as the guard moves it", async () => {
    const place = await previewRunPlace(
      { agentId: 'quill' },
      meshWith(agent),
      deps({ mode: 'none', defaultCwd: home })
    );
    expect(place).toEqual({ kind: 'agent', path: agent });
    expect(guardRunPlacement({ cwd: home, agentPath: agent }).cwd).toBe(agent);
  });

  it('names the default folder when a `none` binding lands somewhere the guard keeps', async () => {
    const place = await previewRunPlace(
      { agentId: 'quill' },
      meshWith(agent),
      deps({ mode: 'none', defaultCwd: elsewhere })
    );
    expect(place).toEqual({ kind: 'folder', path: elsewhere });
    expect(guardRunPlacement({ cwd: elsewhere, agentPath: agent }).cwd).toBe(elsewhere);
  });

  it('claims nothing for an agent the registry no longer holds', async () => {
    const place = await previewRunPlace({ agentId: 'quill' }, meshWith(undefined), deps({}));
    expect(place).toBeUndefined();
  });

  it('claims nothing when its own folder is the data folder, where no run may start', async () => {
    const place = await previewRunPlace({ agentId: 'quill' }, meshWith(dork), deps({}));
    expect(place).toBeUndefined();
    expect(() => guardRunPlacement({ cwd: dork, agentPath: dork })).toThrow();
  });
});

describe('a parked schedule with no agent', () => {
  it.each([
    ['the home folder', () => home],
    ['a folder above it', () => above],
    ['the data folder', () => dork],
  ])('says a fresh private folder when the server stands in %s', async (_name, cwd) => {
    const place = await previewRunPlace(
      { agentId: null },
      meshWith(agent),
      deps({ serverCwd: cwd() })
    );
    expect(place).toEqual({ kind: 'private' });
    expect(path.dirname(guardRunPlacement({ cwd: cwd() }).cwd)).toBe(
      path.join(dork, SCHEDULED_RUNS_DIR)
    );
  });

  it("names the server's folder when the guard keeps it", async () => {
    const place = await previewRunPlace(
      { agentId: null },
      meshWith(agent),
      deps({ serverCwd: elsewhere })
    );
    expect(place).toEqual({ kind: 'folder', path: elsewhere });
    expect(guardRunPlacement({ cwd: elsewhere }).cwd).toBe(elsewhere);
  });

  it('makes no run folder just to answer', async () => {
    await previewRunPlace({ agentId: null }, meshWith(agent), deps({ serverCwd: home }));
    expect(fs.existsSync(path.join(dork, SCHEDULED_RUNS_DIR))).toBe(false);
  });
});

describe('withTaskRunPlace', () => {
  const parked = { id: 't1', agentId: 'quill', status: 'pending_approval' } as Task;

  it('stamps a parked schedule', async () => {
    const task = await withTaskRunPlace(parked, meshWith(agent), deps({}));
    expect(task.runPlace).toEqual({ kind: 'agent', path: agent });
  });

  it('leaves every other schedule alone, since only the approval card reads it', async () => {
    const active = { ...parked, status: 'active' } as Task;
    expect(await withTaskRunPlace(active, meshWith(agent), deps({}))).toBe(active);
  });

  it('leaves the field off when no run could start', async () => {
    const task = await withTaskRunPlace(parked, meshWith(dork), deps({}));
    expect(task).not.toHaveProperty('runPlace');
  });
});
