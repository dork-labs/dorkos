/**
 * A task or agent that says it reads outside text stays declared until a person says otherwise
 * (DOR-3969): DorkOS keeps its own record, an agent editing its own file back to false changes
 * nothing, the record survives a restart, and every turn of a declared agent carries the outsider
 * mark through the registry's level seam.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readManifest, writeManifest } from '@dorkos/shared/manifest';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { AgentUpdateError, updateAgentManifest } from '../../operator/agent-updater.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../agent-identity/__tests__/agent-home-fixture.js';
import { boundTurnOpts } from '../agent-level-bound.js';
import {
  agentReadsOutsideText,
  DeclaredReaders,
  setDeclaredReaders,
  settleDeclaredTask,
  taskNameKey,
  taskReadsOutsideText,
} from '../declared-readers.js';

const AGENT_ID = '01M054RMQAMZPXHWHRKPGY9Z87';

/** A made-up agent's manifest. */
function manifest(extra: Partial<AgentManifest> = {}): AgentManifest {
  return {
    id: AGENT_ID,
    name: 'wren',
    displayName: 'Wren',
    description: 'Sorts the garden club inbox.',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: '2026-11-17T00:00:00.000Z',
    registeredBy: 'test',
    personaEnabled: true,
    isSystem: false,
    mcpServers: [],
    ...extra,
  } as unknown as AgentManifest;
}

const logger = { warn: vi.fn() };
let dir: string;
let agentPath: string;
let file: string;

beforeEach(async () => {
  logger.warn.mockClear();
  dir = await mkdtemp(path.join(tmpdir(), 'declared-readers-'));
  agentPath = path.join(dir, 'wren');
  await mkdir(path.join(agentPath, '.dork'), { recursive: true });
  await writeManifest(agentPath, manifest());
  file = path.join(dir, 'dork', 'permissions', 'declared-outside-readers.json');
  setDeclaredReaders(new DeclaredReaders({ file, logger }));
});

afterEach(async () => {
  setDeclaredReaders(null);
  clearTestHomes();
  await rm(dir, { recursive: true, force: true });
});

describe('the record of what reads outside text', () => {
  it('survives a restart: a new store on the same file still has it', () => {
    new DeclaredReaders({ file, logger }).declare('task', 'task-1');
    const restarted = new DeclaredReaders({ file, logger });
    expect(restarted.has('task', 'task-1')).toBe(true);
    expect(restarted.has('agent', 'task-1')).toBe(false);
  });

  it('is cleared only by the person path, and that survives a restart too', () => {
    const store = new DeclaredReaders({ file, logger });
    store.declare('agent', AGENT_ID);
    store.clearByPerson('agent', AGENT_ID);
    expect(new DeclaredReaders({ file, logger }).has('agent', AGENT_ID)).toBe(false);
  });

  it('a task write that turns it off clears it only for a person, by id and by name', () => {
    const task = { id: 'task-1', agentId: AGENT_ID, name: 'inbox-sweep' };
    settleDeclaredTask(task, true, false);
    settleDeclaredTask(task, false, false);
    expect(taskReadsOutsideText('task-1')).toBe(true);
    settleDeclaredTask(task, false, true);
    expect(taskReadsOutsideText('task-1')).toBe(false);
    // Nothing left under its name for a later sync to carry back.
    const restarted = new DeclaredReaders({ file, logger });
    expect(restarted.has('taskName', taskNameKey(AGENT_ID, 'inbox-sweep'))).toBe(false);
  });

  it('an unreadable record is logged, left as it is, and the file still counts', async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{ not json', 'utf-8');
    setDeclaredReaders(new DeclaredReaders({ file, logger }));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    await writeManifest(agentPath, manifest({ readsOutsideText: true }));
    expect(await agentReadsOutsideText(agentPath)).toBe(true);
    // Nothing was written over the broken record, so a person can still repair it.
    expect(await readFile(file, 'utf-8')).toBe('{ not json');
    expect(taskReadsOutsideText('task-1')).toBe(false);
  });
});

describe('an agent that says it reads outside text', () => {
  it('stays declared after its own file is edited back to false, across a restart', async () => {
    await writeManifest(agentPath, manifest({ readsOutsideText: true }));
    expect(await agentReadsOutsideText(agentPath)).toBe(true);
    await writeManifest(agentPath, manifest({ readsOutsideText: false }));
    expect(await agentReadsOutsideText(agentPath)).toBe(true);
    setDeclaredReaders(new DeclaredReaders({ file, logger }));
    expect(await agentReadsOutsideText(agentPath)).toBe(true);
  });

  it('is not declared when nothing ever said so', async () => {
    expect(await agentReadsOutsideText(agentPath)).toBe(false);
  });

  it('stays declared when its own file cannot be read, or names another id', async () => {
    await writeManifest(agentPath, manifest({ readsOutsideText: true }));
    expect(await agentReadsOutsideText(agentPath)).toBe(true);
    await writeFile(path.join(agentPath, '.dork', 'agent.json'), '{ not json', 'utf-8');
    expect(await agentReadsOutsideText(agentPath)).toBe(true);
    await writeManifest(agentPath, manifest({ id: '01M054RMQAMZPXHWHRKPGY9Z88' }));
    expect(await agentReadsOutsideText(agentPath)).toBe(true);
    // And across a restart: the folder is in the record on disk.
    setDeclaredReaders(new DeclaredReaders({ file, logger }));
    expect(await agentReadsOutsideText(agentPath)).toBe(true);
  });

  it('reads as declared when its file is there but cannot be read, even if never declared', async () => {
    await writeFile(path.join(agentPath, '.dork', 'agent.json'), '{ not json', 'utf-8');
    expect(await agentReadsOutsideText(agentPath)).toBe(true);
  });

  it('says nothing for a folder with no file at all', async () => {
    await rm(path.join(agentPath, '.dork', 'agent.json'));
    expect(await agentReadsOutsideText(agentPath)).toBe(false);
  });

  it('can turn it on through its own update, and cannot turn it off', async () => {
    await updateAgentManifest({ agentPath, body: { readsOutsideText: true } });
    expect((await readManifest(agentPath))?.readsOutsideText).toBe(true);
    for (const value of [false, null]) {
      const refused = await updateAgentManifest({
        agentPath,
        body: { readsOutsideText: value },
      }).catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(AgentUpdateError);
      expect((refused as AgentUpdateError).code).toBe('OPERATOR_ONLY');
    }
    expect((await readManifest(agentPath))?.readsOutsideText).toBe(true);
    // Editing the file by hand does not clear the record the update wrote.
    await writeManifest(agentPath, manifest());
    expect(await agentReadsOutsideText(agentPath)).toBe(true);
  });

  it('is turned off by a person through the same update, in the record and the file', async () => {
    await updateAgentManifest({ agentPath, body: { readsOutsideText: true } });
    const refused = await updateAgentManifest({
      agentPath,
      body: { readsOutsideText: false },
      byPerson: false,
    }).catch((err: unknown) => err);
    expect((refused as AgentUpdateError).code).toBe('OPERATOR_ONLY');
    expect((refused as AgentUpdateError).message).toBe(
      'DorkOS changed nothing. Only a person can turn this off: readsOutsideText.'
    );

    await updateAgentManifest({ agentPath, body: { readsOutsideText: false }, byPerson: true });
    expect((await readManifest(agentPath))?.readsOutsideText).toBe(false);
    expect(await agentReadsOutsideText(agentPath)).toBe(false);
    setDeclaredReaders(new DeclaredReaders({ file, logger }));
    expect(await agentReadsOutsideText(agentPath)).toBe(false);
  });
});

describe('every turn of a declared agent carries the outsider mark', () => {
  const runtime = {
    type: 'claude-code',
    getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
  } as unknown as AgentRuntime;
  const deps = {
    storedModeOf: () => 'bypassPermissions',
    // Nothing set anywhere: the level half leaves the turn exactly as sent.
    levelOf: async () => ({ stop: null, mode: undefined }) as never,
  };

  beforeEach(() => registerTestHomes([agentPath]));

  it('marks the turn of a declared agent, whatever its level', async () => {
    await writeManifest(agentPath, manifest({ readsOutsideText: true }));
    const sent = await boundTurnOpts(runtime, 'chat-1', { cwd: agentPath }, deps);
    expect(sent?.carriedMarks).toEqual({ outsider: true });
  });

  it('marks it from the record alone, after the file was edited back', async () => {
    new DeclaredReaders({ file, logger }).declare('agent', AGENT_ID);
    setDeclaredReaders(new DeclaredReaders({ file, logger }));
    const sent = await boundTurnOpts(runtime, 'chat-1', { cwd: agentPath }, deps);
    expect(sent?.carriedMarks).toEqual({ outsider: true });
  });

  it('marks the turn when whether the agent reads outside text cannot be read', async () => {
    const failing = {
      ...deps,
      readsOutsideText: async () => {
        throw new Error('the record could not be read');
      },
    };
    const sent = await boundTurnOpts(runtime, 'chat-1', { cwd: agentPath }, failing);
    expect(sent?.carriedMarks).toEqual({ outsider: true });
  });

  it('leaves the turn of an undeclared agent unmarked', async () => {
    const sent = await boundTurnOpts(runtime, 'chat-1', { cwd: agentPath }, deps);
    expect(sent?.carriedMarks).toBeUndefined();
  });
});
