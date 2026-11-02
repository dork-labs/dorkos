/**
 * Whose schedule an agent may make (DOR-3640 R1). A schedule runs as the agent
 * it is filed under, so an agent may file one only under itself or `global`,
 * and only one filed under itself may arm without a person, even on a Trusted
 * install. Driven through `createScheduledTask` with a real store and file.
 *
 * @module services/tasks/lifecycle/__tests__/create-task-target
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MeshCore } from '@dorkos/mesh';
import { createTestDb } from '@dorkos/test-utils/db';
import { TaskStore } from '../../task-store.js';
import { createScheduledTask } from '../create-task.js';
import { agentIdOfHome } from '../../approvals/schedule-owner.js';

const state = vi.hoisted(() => ({
  preset: 'trusted' as 'trusted' | 'careful',
  notified: [] as string[],
  raised: [] as string[],
}));

vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'permissions' ? { preset: state.preset } : undefined),
  },
}));
vi.mock('../../../notifications/notification-service.js', () => ({
  notify: async (kind: string) => {
    state.notified.push(kind);
    return { notification: null, deduped: false };
  },
  resolveStanding: async () => undefined,
}));
vi.mock('../../../notifications/standing-events.js', () => ({
  raiseStanding: (kind: string) => {
    state.raised.push(kind);
  },
}));

let store: TaskStore;
let scratch: string;
let homeA: string;
let homeB: string;

function mesh(): MeshCore {
  const agents = [
    { id: 'agent-a', projectPath: homeA },
    { id: 'agent-b', projectPath: homeB },
  ];
  return {
    listWithPaths: () => agents,
    getProjectPath: (id: string) => agents.find((a) => a.id === id)?.projectPath,
  } as unknown as MeshCore;
}

beforeEach(async () => {
  state.preset = 'trusted';
  state.notified = [];
  state.raised = [];
  store = new TaskStore(createTestDb());
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'create-task-target-')));
  homeA = path.join(scratch, 'a');
  homeB = path.join(scratch, 'b');
  await fs.mkdir(homeA, { recursive: true });
  await fs.mkdir(homeB, { recursive: true });
});

afterEach(async () => {
  store.close();
  await fs.rm(scratch, { recursive: true, force: true });
});

/** Create a schedule as agent A, the way both agent doors do. */
function aCreates(target: string, caller: string | null = homeA) {
  const callerAgentPath = caller ?? undefined;
  return createScheduledTask(
    { store, registrar: null, dorkHome: scratch, meshCore: mesh() },
    {
      input: {
        name: 'Nightly sweep',
        description: 'Sweep the backlog',
        prompt: 'Sweep the backlog.',
        cron: '0 3 * * *',
        target,
        reason: 'The backlog needs sweeping.',
      },
      trusted: false,
      callerIsOurAgent: true,
      ...(callerAgentPath !== undefined ? { callerAgentPath } : {}),
      proposal: { sessionId: 'ses-a', agentPath: callerAgentPath ?? null },
    }
  );
}

describe('an agent filing a schedule', () => {
  it('is refused for another agent, and writes nothing', async () => {
    const outcome = await aCreates('agent-b');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(403);
    expect(outcome.code).toBe('not_your_agent');
    expect(store.getTasks()).toEqual([]);
  });

  it('arms one under itself on a Trusted install', async () => {
    const outcome = await aCreates('agent-a');
    expect(outcome.ok && outcome.parked).toBe(false);
    expect(state.notified).toEqual(['schedule.armed_by_agent']);
  });

  it('may file a global one, which never arms without a person', async () => {
    const outcome = await aCreates('global');
    expect(outcome.ok && outcome.parked).toBe(true);
    expect(state.raised).toEqual(['schedule.parked']);
    expect(state.notified).toEqual([]);
  });

  it('parks one under itself on a Careful install', async () => {
    state.preset = 'careful';
    const outcome = await aCreates('agent-a');
    expect(outcome.ok && outcome.parked).toBe(true);
  });

  it('parks, never arms, when DorkOS cannot say which agent asked', async () => {
    const outcome = await aCreates('agent-a', null);
    expect(outcome.ok && outcome.parked).toBe(true);
    expect(state.notified).toEqual([]);
  });
});

describe('a caller whose home is a link that matches two agents (DOR-3666)', () => {
  it('comes back unnamed, and its schedule parks', async () => {
    // Two registered homes that are one folder by real path, and a caller
    // that reaches it through a third spelling: nobody can say which agent asked.
    const shared = path.join(scratch, 'shared');
    await fs.mkdir(shared, { recursive: true });
    const linkA = path.join(scratch, 'link-a');
    const linkB = path.join(scratch, 'link-b');
    const linkC = path.join(scratch, 'link-c');
    for (const link of [linkA, linkB, linkC]) await fs.symlink(shared, link);
    const both = [
      { id: 'agent-a', projectPath: linkA },
      { id: 'agent-b', projectPath: linkB },
    ];
    const meshCore = {
      listWithPaths: () => both,
      getProjectPath: (id: string) => both.find((a) => a.id === id)?.projectPath,
    } as unknown as MeshCore;
    expect(agentIdOfHome(meshCore, linkC)).toBeUndefined();

    const outcome = await createScheduledTask(
      { store, registrar: null, dorkHome: scratch, meshCore },
      {
        input: {
          name: 'linked-sweep',
          description: 'x',
          prompt: 'Sweep.',
          cron: '0 3 * * *',
          target: 'global',
          reason: 'The backlog needs sweeping.',
        },
        trusted: false,
        callerIsOurAgent: true,
        callerAgentPath: linkC,
        proposal: { sessionId: 'ses-c', agentPath: linkC },
      }
    );
    expect(outcome.ok && outcome.parked).toBe(true);
    expect(state.notified).toEqual([]);
  });
});
