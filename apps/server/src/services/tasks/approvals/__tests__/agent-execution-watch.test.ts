/**
 * When DorkOS looks for an agent's runtime, model or effort changed outside
 * DorkOS (DOR-2337): every agent has a baseline before an edit could matter,
 * the record lives in DorkOS's own state, and a scheduled fire runs on exactly
 * what its check read.
 *
 * @module services/tasks/approvals/__tests__/agent-execution-watch
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import { writeManifest, readManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { Task } from '@dorkos/shared/types';

import { TaskStore } from '../../task-store.js';
import {
  agentExecutionRecordPath,
  startAgentExecutionWatch,
  type AgentExecutionWatch,
  type WatchedAgent,
} from '../agent-execution-watch.js';

describe('startAgentExecutionWatch', () => {
  let root: string;
  let dorkHome: string;
  let agents: WatchedAgent[];
  let store: TaskStore;
  let raised: string[];
  let watch: AgentExecutionWatch;

  async function addAgent(id: string, model = 'claude-sonnet-4'): Promise<string> {
    const projectPath = path.join(root, id);
    fs.mkdirSync(projectPath, { recursive: true });
    await writeManifest(projectPath, {
      id,
      name: id,
      description: '',
      runtime: 'claude-code',
      model,
      capabilities: [],
      behavior: { responseMode: 'always' },
      registeredAt: new Date().toISOString(),
      registeredBy: 'test',
      personaEnabled: true,
      isSystem: false,
      enabledToolGroups: {},
      mcpServers: [],
      workspace: { mode: 'home' },
    } as AgentManifest);
    agents.push({ id, name: id, projectPath });
    return projectPath;
  }

  async function editFile(projectPath: string, fields: Partial<AgentManifest>): Promise<void> {
    await writeManifest(projectPath, { ...(await readManifest(projectPath))!, ...fields });
  }

  function follower(agentId: string): Task {
    return store.createTask({
      name: `digest-${agentId}`,
      description: 'digest',
      prompt: 'Post the digest.',
      cron: '0 7 * * *',
      agentId,
      filePath: `/skills/digest-${agentId}/SKILL.md`,
    });
  }

  /** The agents the record holds a baseline for. */
  function baselines(): string[] {
    const file = agentExecutionRecordPath(dorkHome);
    return fs.existsSync(file) ? Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))) : [];
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-watch-'));
    dorkHome = path.join(root, 'dork-home');
    agents = [];
    store = new TaskStore(createTestDb());
    raised = [];
    watch = startAgentExecutionWatch({
      dorkHome,
      store,
      agents: () => agents,
      onParked: async (tasks) => {
        raised.push(...tasks.map((t) => t.id));
      },
      activity: { emit: async () => {} },
      logger: { warn: () => {} },
    });
  });

  afterEach(() => {
    watch.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps its record beside the permission record, not in the agents’ tree', () => {
    const file = agentExecutionRecordPath(dorkHome);
    expect(path.dirname(file)).toBe(path.join(dorkHome, 'permissions'));
    expect(file.startsWith(path.join(dorkHome, 'agents'))).toBe(false);
  });

  it('gives every registered agent a baseline at boot, followed or not', async () => {
    // Purpose: an agent first seen after an edit would carry the edit in as its
    // baseline, silently. An agent nobody follows yet can gain a follower later.
    const lonely = await addAgent('agent-lonely');
    await watch.checkAll();
    expect(baselines()).toEqual(['agent-lonely']);

    const task = follower('agent-lonely');
    await editFile(lonely, { model: 'claude-opus-4' });
    await watch.checkAll();

    expect(store.getTask(task.id)!.status).toBe('pending_approval');
    expect(raised).toEqual([task.id]);
  });

  it('gives an agent a baseline when it registers', async () => {
    const late = await addAgent('agent-late');
    await watch.checkAgent(late);

    expect(baselines()).toEqual(['agent-late']);
  });

  it('gives an agent a baseline when a schedule of its is approved', async () => {
    // Purpose: the last line of defence for an agent nothing else looked at.
    await addAgent('agent-new');

    follower('agent-new');

    await vi.waitFor(() => expect(baselines()).toEqual(['agent-new']));
  });

  it('answers what the check before a fire read, for the run to use', async () => {
    const projectPath = await addAgent('agent-fire');
    const task = follower('agent-fire');
    await watch.checkAll();

    expect(await watch.beforeScheduledFire(task)).toEqual({
      runtime: 'claude-code',
      model: 'claude-sonnet-4',
    });

    await editFile(projectPath, { model: 'claude-opus-4' });
    expect(await watch.beforeScheduledFire(task)).toEqual({
      runtime: 'claude-code',
      model: 'claude-opus-4',
    });
    expect(store.getTask(task.id)!.status).toBe('pending_approval');
  });

  it('answers nothing for a schedule whose agent is not registered', async () => {
    const task = follower('agent-gone');
    expect(await watch.beforeScheduledFire(task)).toBeUndefined();
  });
});
