/**
 * A marketplace agent install's identity files are the agent's own (DOR-2245,
 * ADR 260923-163516): a readable agent.json is adopted with its id, a parked
 * identity is restored, and SOUL/NOPE/MEMORY are written only where absent.
 * Real filesystem, sealed in a temp tree like `agent-creator-dork-home.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const mockConfigGet = vi.fn();
vi.mock('../config-manager.js', () => ({
  configManager: { get: (...a: unknown[]) => mockConfigGet(...a), set: vi.fn() },
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
const notified: { origin: string; id: string }[] = [];
vi.mock('../agent-created-hook.js', () => ({
  notifyAgentCreated: vi.fn(async (a: { origin: string; id: string }) => {
    notified.push({ origin: a.origin, id: a.id });
  }),
}));

import { createAgentWorkspace } from '../agent-creator.js';
import { initBoundary } from '../../../lib/boundary.js';
import { CreateAgentOptionsSchema } from '@dorkos/shared/mesh-schemas';

let tmpRoot: string;
let realDorkHome: string | undefined;
beforeEach(async () => {
  notified.length = 0;
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-mkt-')));
  realDorkHome = process.env.DORK_HOME;
  process.env.DORK_HOME = path.join(tmpRoot, 'dork-home');
  await fs.mkdir(process.env.DORK_HOME);
  await initBoundary(tmpRoot);
  mockConfigGet.mockReturnValue({
    defaultDirectory: path.join(tmpRoot, 'agents'),
    defaultAgent: 'nobody',
  });
});
afterEach(async () => {
  if (realDorkHome === undefined) delete process.env.DORK_HOME;
  else process.env.DORK_HOME = realDorkHome;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function read(dir: string, rel: string): Promise<string | null> {
  return fs.readFile(path.join(dir, rel), 'utf8').catch(() => null);
}

async function agentDir(): Promise<string> {
  const dir = path.join(tmpRoot, 'agents', 'bot');
  await fs.mkdir(path.join(dir, '.dork'), { recursive: true });
  return dir;
}

const input = (dir: string) => ({ directory: dir, name: 'bot', skipTemplateDownload: true });

describe('createAgentWorkspace in marketplace mode', () => {
  // Purpose: an update keeps the agent's id, persona and memory (review blocker 2).
  it('adopts an existing agent.json and never rewrites SOUL, NOPE or MEMORY', async () => {
    const dir = await agentDir();
    const first = await createAgentWorkspace(input(dir), undefined, { marketplace: true });
    await fs.writeFile(path.join(dir, '.dork', 'SOUL.md'), 'my persona');
    await fs.writeFile(path.join(dir, '.dork', 'MEMORY.md'), 'my notes');

    const second = await createAgentWorkspace(input(dir), undefined, { marketplace: true });

    expect(second.manifest.id).toBe(first.manifest.id);
    expect(second.adopted).toBe(true);
    expect(await read(dir, '.dork/SOUL.md')).toBe('my persona');
    expect(await read(dir, '.dork/MEMORY.md')).toBe('my notes');
    expect(notified.map((n) => n.origin)).toEqual(['created', 'registered']);
  });

  // Purpose: a package-shipped SOUL.md survives a FRESH install too.
  it('keeps a shipped SOUL.md on a fresh install', async () => {
    const dir = await agentDir();
    await fs.writeFile(path.join(dir, '.dork', 'SOUL.md'), 'shipped persona');
    const result = await createAgentWorkspace(input(dir), undefined, { marketplace: true });
    expect(result.adopted).toBeUndefined();
    expect(await read(dir, '.dork/SOUL.md')).toBe('shipped persona');
  });

  // Purpose: a reinstall after uninstall restores the parked identity.
  it('restores a parked uninstalled-agent.json and keeps its id', async () => {
    const dir = await agentDir();
    const first = await createAgentWorkspace(input(dir), undefined, { marketplace: true });
    await fs.rename(
      path.join(dir, '.dork', 'agent.json'),
      path.join(dir, '.dork', 'uninstalled-agent.json')
    );
    const again = await createAgentWorkspace(input(dir), undefined, { marketplace: true });
    expect(again.manifest.id).toBe(first.manifest.id);
    expect(await read(dir, '.dork/uninstalled-agent.json')).toBeNull();
  });

  // Purpose: a stale parked copy beside a kept manifest is removed on adoption.
  it('removes a parked copy when agent.json is already there', async () => {
    const dir = await agentDir();
    await createAgentWorkspace(input(dir), undefined, { marketplace: true });
    await fs.writeFile(path.join(dir, '.dork', 'uninstalled-agent.json'), '{"id":"stale"}');
    await createAgentWorkspace(input(dir), undefined, { marketplace: true });
    expect(await read(dir, '.dork/uninstalled-agent.json')).toBeNull();
  });

  // Purpose: an unreadable manifest is the only copy of an identity; never write over it.
  it('refuses to overwrite an unreadable agent.json', async () => {
    const dir = await agentDir();
    await fs.writeFile(path.join(dir, '.dork', 'agent.json'), '{ not json');
    await expect(
      createAgentWorkspace(input(dir), undefined, { marketplace: true })
    ).rejects.toThrow(/can't be read/);
    expect(await read(dir, '.dork/agent.json')).toBe('{ not json');
  });

  // Purpose: an update of an agent that never left the team is not announced again.
  it('does not announce an adopted agent that is already registered', async () => {
    const dir = await agentDir();
    const first = await createAgentWorkspace(input(dir), undefined, { marketplace: true });
    notified.length = 0;
    const mesh = {
      syncFromDisk: vi.fn().mockResolvedValue({ status: 'synced' }),
      getByPath: () => ({ id: first.manifest.id }),
    };
    await createAgentWorkspace(input(dir), mesh as never, { marketplace: true });
    expect(notified).toEqual([]);
  });

  // Purpose: installing is an explicit act; it lifts a denial on the agent's folder.
  it('lifts a denial on its own folder and says so', async () => {
    const dir = await agentDir();
    const undeny = vi.fn().mockResolvedValue(undefined);
    const mesh = {
      syncFromDisk: vi.fn().mockResolvedValue({ status: 'synced' }),
      listDenied: () => [{ path: dir }],
      undeny,
    };
    const result = await createAgentWorkspace(input(dir), mesh as never, { marketplace: true });
    expect(undeny).toHaveBeenCalledWith(dir);
    expect(result.denialLifted).toBe(true);
  });

  // Purpose: new package defaults are reported, not applied over the agent's own.
  it('reports differing package defaults instead of applying them', async () => {
    const dir = await agentDir();
    await createAgentWorkspace(input(dir), undefined, { marketplace: true });
    const again = await createAgentWorkspace(
      {
        ...input(dir),
        traits: { tone: 5, autonomy: 1, caution: 1, communication: 1, creativity: 1 },
      },
      undefined,
      { marketplace: true }
    );
    expect(again.defaultsDiffer).toBe(true);
    expect(again.manifest.traits).not.toEqual({
      tone: 5,
      autonomy: 1,
      caution: 1,
      communication: 1,
      creativity: 1,
    });
  });

  // Purpose: marketplace mode needs files already on disk, and is not reachable from a body.
  it('requires skipTemplateDownload, and the public schema strips the option', async () => {
    const dir = await agentDir();
    await expect(
      createAgentWorkspace({ directory: dir, name: 'bot' }, undefined, { marketplace: true })
    ).rejects.toThrow();
    const parsed = CreateAgentOptionsSchema.parse({ name: 'bot', marketplace: true } as never);
    expect('marketplace' in parsed).toBe(false);
  });
});
