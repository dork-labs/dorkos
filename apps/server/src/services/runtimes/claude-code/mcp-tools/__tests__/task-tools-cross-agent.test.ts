/**
 * A Full autonomy agent schedules for another agent (DOR-3938), on Security's five Musts:
 * Full is read from the server's own turn record; a marked turn is refused; the task keeps its
 * creator and each run records it and starts with its marks; the mode is capped at the target
 * agent's level, Bypass included, on create and on update.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MeshCore } from '@dorkos/mesh';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { createTestDb } from '@dorkos/test-utils/db';

vi.mock('../../../../audit/audit-trail.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../audit/audit-trail.js')>()),
  recordAudit: vi.fn(),
}));

/** Each agent's own level, by home folder; set per test. */
const levels = new Map<string, string | undefined>();
vi.mock('../../../../session/resolution/agent-launch-level.js', () => ({
  resolveAgentLaunchLevel: async ({ agentPath }: { agentPath: string }) => ({
    stop: null,
    mode: levels.get(agentPath),
  }),
}));

vi.mock('../../../../tasks/scheduled-run-power.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../tasks/scheduled-run-power.js')>();
  const { CLAUDE_CODE_CAPABILITIES } = await import('../../runtime-constants.js');
  // A runtime named `no-modes` declares none, so a cap read against it falls back to Default.
  const none = { ...CLAUDE_CODE_CAPABILITIES, permissionModes: { supported: false, values: [] } };
  return {
    ...actual,
    capabilitiesForTaskRuntime: (runtime?: string | null) =>
      runtime === 'no-modes' ? none : CLAUDE_CODE_CAPABILITIES,
  };
});

import { TaskStore } from '../../../../tasks/task-store.js';
import { getTasksTools } from '../tasks/task-tools.js';
import type { McpToolDeps } from '../types.js';
import { recordAudit } from '../../../../audit/audit-trail.js';
import { MCP_TOOL_TIERS } from '../../../../core/mcp-tool-tiers.js';
import { recordTurnLevels } from '../../../../core/turn-power/turn-levels.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtime-constants.js';
import {
  capModeAtAgentLevel,
  creatorMarked,
  recordedRunCreator,
  crossAgentRefusal,
  withCreatorMarks,
} from '../../../../tasks/approvals/cross-agent.js';
import { eq } from 'drizzle-orm';
import { pulseRuns, type Db } from '@dorkos/db';

interface SessionTool {
  name: string;
  handler: (
    args: Record<string, unknown>,
    extra: unknown
  ) => Promise<{ isError?: boolean; content: { text: string }[] }>;
}

let store: TaskStore;
let db: Db;
let scratch: string;
let homeA: string;
let homeB: string;
let homeC: string;
let deps: McpToolDeps;
let mesh: MeshCore;
let serial = 0;

/** The creator a run recorded, read from its row. */
function creatorOfRun(id: string) {
  return recordedRunCreator(db.select().from(pulseRuns).where(eq(pulseRuns.id, id)).get());
}

/** Run one turn in a chat stored at `stored`, so the server has a real level for it. */
async function ranTurn(stored: string, opts?: Record<string, unknown>): Promise<string> {
  const sessionId = `ses-cross-${++serial}`;
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => stored
  );
  for await (const _event of runtime.sendMessage(sessionId, 'hi', opts as never)) {
    // drain
  }
  return sessionId;
}

beforeEach(async () => {
  vi.mocked(recordAudit).mockClear();
  levels.clear();
  db = createTestDb();
  store = new TaskStore(db);
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'task-tools-cross-')));
  homeA = path.join(scratch, 'a');
  homeB = path.join(scratch, 'b');
  await fs.mkdir(homeA, { recursive: true });
  await fs.mkdir(homeB, { recursive: true });
  homeC = path.join(scratch, 'c');
  await fs.mkdir(homeC, { recursive: true });
  const agents = [
    { id: 'agent-a', name: 'alpha', projectPath: homeA },
    { id: 'agent-b', name: 'bravo', projectPath: homeB },
    { id: 'agent-c', name: 'charlie', projectPath: homeC },
  ];
  mesh = {
    listWithPaths: () => agents,
    getProjectPath: (id: string) => agents.find((a) => a.id === id)?.projectPath,
  } as unknown as MeshCore;
  deps = {
    taskStore: store,
    defaultCwd: scratch,
    dorkHome: scratch,
    meshCore: mesh,
  } as unknown as McpToolDeps;
});

afterEach(async () => {
  store.close();
  await fs.rm(scratch, { recursive: true, force: true });
});

/** Agent A's in-session tools, from the chat `sessionId`. */
function toolsOfA(sessionId: string): Record<string, SessionTool> {
  return toolsOf(homeA, sessionId);
}

/** An agent's in-session tools, from the chat `sessionId`. */
function toolsOf(agentPath: string, sessionId: string): Record<string, SessionTool> {
  const tools = getTasksTools(deps, () => ({ sessionId, agentPath }));
  return Object.fromEntries((tools as unknown as SessionTool[]).map((t) => [t.name, t] as const));
}

async function call(tools: Record<string, SessionTool>, name: string, args: object) {
  const result = await tools[name]!.handler(args as Record<string, unknown>, undefined);
  return {
    isError: result.isError === true,
    payload: JSON.parse(result.content[0]!.text) as Record<string, unknown>,
  };
}

const ARGS = {
  name: 'sweep',
  prompt: 'Sweep the inbox.',
  cron: '0 3 * * *',
  reason: 'Bravo asked for a nightly sweep.',
};

/** A task filed under agent B, at `permissionMode`. */
function bTask(permissionMode: string) {
  return store.createTask({
    name: 'b-nightly',
    description: 'b',
    prompt: 'B’s work.',
    cron: '0 2 * * *',
    agentId: 'agent-b',
    permissionMode: permissionMode as never,
    filePath: path.join(scratch, 'none', 'SKILL.md'),
  });
}

describe('Must 1 and 5: Full creates for another agent; below Full is refused', () => {
  it('a Full turn files a task under another agent, records who made it, and audits it', async () => {
    const tools = toolsOfA(await ranTurn('bypassPermissions'));
    const { isError, payload } = await call(tools, 'tasks_create', { ...ARGS, target: 'agent-b' });
    expect(isError).toBe(false);
    const [task] = store.getTasks();
    expect(task!.agentId).toBe('agent-b');
    expect(task!.proposedByAgentPath).toBe(homeA);
    expect((payload.schedule as { id: string }).id).toBe(task!.id);
    expect(vi.mocked(recordAudit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tasks.create_for_agent',
        summary: expect.stringContaining('for bravo'),
        change: expect.arrayContaining([
          { field: 'createdBy', after: homeA },
          { field: 'createdFor', after: 'agent-b' },
        ]),
      })
    );
  });

  it.each(['acceptEdits', 'default', 'dontAsk'])(
    'a turn at %s is refused, as before, and nothing is written',
    async (mode) => {
      const tools = toolsOfA(await ranTurn(mode));
      const { isError, payload } = await call(tools, 'tasks_create', {
        ...ARGS,
        target: 'agent-b',
      });
      expect(isError).toBe(true);
      expect(payload.code).toBe('not_your_agent');
      expect(store.getTasks()).toEqual([]);
    }
  );

  it('a chat the server ran no turn on is not Full, whatever it claims', async () => {
    const { isError, payload } = await call(toolsOfA('ses-never-ran'), 'tasks_create', {
      ...ARGS,
      target: 'agent-b',
      permissionMode: 'bypassPermissions',
    });
    expect(isError).toBe(true);
    expect(store.getTasks()).toEqual([]);
    expect(payload.code).not.toBe(undefined);
  });

  it('a Full chat held to a lower ceiling for its turn is not Full', async () => {
    const sessionId = await ranTurn('bypassPermissions', {
      permissionCeiling: { asks: 'some', reach: 'files' },
    });
    expect(crossAgentRefusal({ sessionId, agentPath: homeA })?.code).toBe('cross_agent_needs_full');
  });

  it('a Full turn may change another agent’s task; below Full it may not', async () => {
    const theirs = bTask('acceptEdits');
    levels.set(homeB, 'acceptEdits');
    const below = await call(toolsOfA(await ranTurn('acceptEdits')), 'tasks_update', {
      id: theirs.id,
      prompt: 'Something else.',
    });
    expect(below.isError).toBe(true);
    expect(below.payload.code).toBe('not_your_schedule');
    expect(store.getTask(theirs.id)!.prompt).toBe('B’s work.');

    const full = await call(toolsOfA(await ranTurn('bypassPermissions')), 'tasks_update', {
      id: theirs.id,
      cron: '0 4 * * *',
    });
    expect(full.isError).toBe(false);
    expect(store.getTask(theirs.id)!.cron).toBe('0 4 * * *');
    expect(vi.mocked(recordAudit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'tasks.update_for_agent' })
    );
  });
});

/** A teammate's chain, as a ceiling that lowers nothing (how a room hop carries it). */
const TEAMMATE = [{ roomId: 'room-1', authorId: 'author-1' }];
const TEAMMATE_HOP = {
  permissionCeiling: { asks: 'never', reach: 'everything', teammate: TEAMMATE },
};

describe('Must 2: only the outsider mark refuses', () => {
  it('refuses tasks_create for another agent from a Full turn that read an outsider', async () => {
    const tools = toolsOfA(
      await ranTurn('bypassPermissions', { carriedMarks: { outsider: true } })
    );
    const { isError, payload } = await call(tools, 'tasks_create', { ...ARGS, target: 'agent-b' });
    expect(isError).toBe(true);
    expect(payload.code).toBe('cross_agent_marked_turn');
    expect(store.getTasks()).toEqual([]);
  });

  it('refuses tasks_update on another agent’s task from a Full turn that read an outsider', async () => {
    const theirs = bTask('acceptEdits');
    const tools = toolsOfA(
      await ranTurn('bypassPermissions', { carriedMarks: { outsider: true } })
    );
    const { isError, payload } = await call(tools, 'tasks_update', {
      id: theirs.id,
      prompt: 'Something else.',
    });
    expect(isError).toBe(true);
    expect(payload.code).toBe('cross_agent_marked_turn');
    expect(store.getTask(theirs.id)!.prompt).toBe('B’s work.');
  });

  it('refuses an outsider mark that came through a teammate hop, on create and on edit', async () => {
    const both = { ...TEAMMATE_HOP, carriedMarks: { outsider: true } };
    const create = await call(toolsOfA(await ranTurn('bypassPermissions', both)), 'tasks_create', {
      ...ARGS,
      target: 'agent-b',
    });
    expect(create.payload.code).toBe('cross_agent_marked_turn');
    const theirs = bTask('acceptEdits');
    const edit = await call(toolsOfA(await ranTurn('bypassPermissions', both)), 'tasks_update', {
      id: theirs.id,
      prompt: 'Something else.',
    });
    expect(edit.payload.code).toBe('cross_agent_marked_turn');
    expect(store.getTask(theirs.id)!.prompt).toBe('B’s work.');
  });

  it('lets a teammate-marked Full turn create for another agent, and keeps the mark for its runs', async () => {
    const sessionId = await ranTurn('bypassPermissions', TEAMMATE_HOP);
    expect(crossAgentRefusal({ sessionId, agentPath: homeA })).toBeNull();
    const { isError } = await call(toolsOfA(sessionId), 'tasks_create', {
      ...ARGS,
      target: 'agent-b',
    });
    expect(isError).toBe(false);
    const task = store.getTasks()[0]!;
    expect(store.approvals.crossAgentWriterOf(task.id)).toEqual({
      agentPath: homeA,
      sessionId,
      marks: { teammate: TEAMMATE },
    });
    expect(withCreatorMarks(store, task, {}).permissionCeiling).toEqual({
      asks: 'never',
      reach: 'everything',
      teammate: TEAMMATE,
    });
  });

  it('lets a teammate-marked Full turn change another agent’s task', async () => {
    const theirs = bTask('acceptEdits');
    const tools = toolsOfA(await ranTurn('bypassPermissions', TEAMMATE_HOP));
    const { isError } = await call(tools, 'tasks_update', { id: theirs.id, cron: '0 7 * * *' });
    expect(isError).toBe(false);
    expect(store.getTask(theirs.id)!.cron).toBe('0 7 * * *');
  });

  it('still lets an outsider-marked Full turn file a task for itself', async () => {
    const tools = toolsOfA(
      await ranTurn('bypassPermissions', { carriedMarks: { outsider: true } })
    );
    const { isError } = await call(tools, 'tasks_create', { ...ARGS, target: 'agent-a' });
    expect(isError).toBe(false);
    // Its own outsider-marked task parks for a person, as it always has (DOR-3036).
    expect(store.getTasks()[0]!.status).toBe('pending_approval');
  });
});

describe('PM: a prompt edit to another agent’s task', () => {
  it('stays live from a Full, unmarked turn, as a create does', async () => {
    const theirs = bTask('acceptEdits');
    store.approvals.recordApproval(theirs.id);
    levels.set(homeB, 'acceptEdits');
    const tools = toolsOfA(await ranTurn('bypassPermissions'));
    const { isError, payload } = await call(tools, 'tasks_update', {
      id: theirs.id,
      prompt: 'A better sweep.',
    });
    expect(isError).toBe(false);
    expect(payload.needsReapproval).toBeUndefined();
    const after = store.getTask(theirs.id)!;
    expect(after.prompt).toBe('A better sweep.');
    expect(after.status).toBe('active');
  });

  it('below Full is refused, so it stays with a person', async () => {
    const theirs = bTask('acceptEdits');
    store.approvals.recordApproval(theirs.id);
    const tools = toolsOfA(await ranTurn('acceptEdits'));
    const { isError, payload } = await call(tools, 'tasks_update', {
      id: theirs.id,
      prompt: 'A better sweep.',
    });
    expect(isError).toBe(true);
    expect(payload.code).toBe('not_your_schedule');
    expect(store.getTask(theirs.id)!.prompt).toBe('B’s work.');
  });

  it('records the editor, its chat and its marks, so the next run starts with them', async () => {
    const theirs = bTask('acceptEdits');
    const sessionId = await ranTurn('bypassPermissions', TEAMMATE_HOP);
    await call(toolsOfA(sessionId), 'tasks_update', { id: theirs.id, prompt: 'A better sweep.' });
    expect(store.approvals.crossAgentWriterOf(theirs.id)).toEqual({
      agentPath: homeA,
      sessionId,
      marks: { teammate: TEAMMATE },
    });
    const run = store.createRun(theirs.id, 'scheduled');
    store.recordRunExecution(run.id, { runtime: 'claude-code' });
    expect(creatorOfRun(run.id)).toEqual({
      agentPath: homeA,
      sessionId,
      marks: { teammate: TEAMMATE },
    });
  });
});

describe('Security: the creator is merged with every later writer, never replaced', () => {
  const ROOM_1 = [{ roomId: 'room-1', authorId: 'author-1' }];
  const ROOM_2 = [{ roomId: 'room-2', authorId: 'author-2' }];
  const hop = (teammate: typeof ROOM_1) => ({
    permissionCeiling: { asks: 'never', reach: 'everything', teammate },
  });

  it('A creates B’s task and C edits its prompt: the run starts with A’s and C’s marks', async () => {
    const aTurn = await ranTurn('bypassPermissions', hop(ROOM_1));
    await call(toolsOf(homeA, aTurn), 'tasks_create', { ...ARGS, target: 'agent-b' });
    const task = store.getTasks()[0]!;
    const cTurn = await ranTurn('bypassPermissions', hop(ROOM_2));
    const edit = await call(toolsOf(homeC, cTurn), 'tasks_update', {
      id: task.id,
      prompt: 'A better sweep.',
    });
    expect(edit.isError).toBe(false);
    const both = [...ROOM_1, ...ROOM_2];
    expect(store.approvals.crossAgentWriterOf(task.id)).toEqual({
      agentPath: homeC,
      sessionId: cTurn,
      marks: { teammate: both },
    });
    expect(withCreatorMarks(store, task, {}).permissionCeiling).toEqual({
      asks: 'never',
      reach: 'everything',
      teammate: both,
    });
    const run = store.createRun(task.id, 'scheduled');
    store.recordRunExecution(run.id, { runtime: 'claude-code' });
    expect(creatorOfRun(run.id)?.marks).toEqual({ teammate: both });
  });

  it('a person approving the task keeps the writer’s marks', async () => {
    const aTurn = await ranTurn('bypassPermissions', hop(ROOM_1));
    await call(toolsOf(homeA, aTurn), 'tasks_create', { ...ARGS, target: 'agent-b' });
    const task = store.getTasks()[0]!;
    store.approvals.recordApproval(task.id);
    expect(store.approvals.crossAgentWriterOf(task.id)?.marks).toEqual({ teammate: ROOM_1 });
  });
});

describe('Must 4: the cap reads the runtime the edit leaves the task on', () => {
  it('an edit that changes runtime is capped against the new runtime', async () => {
    const theirs = bTask('acceptEdits');
    levels.set(homeB, 'acceptEdits');
    const tools = toolsOfA(await ranTurn('bypassPermissions'));
    const { isError } = await call(tools, 'tasks_update', { id: theirs.id, runtime: 'no-modes' });
    expect(isError).toBe(false);
    // Against Claude Code's modes the task would keep Accept edits; the new runtime declares none.
    expect(store.getTask(theirs.id)!.permissionMode).toBe('default');
  });
});

describe('Security: every tasks_update path runs the gate, a change of target included', () => {
  it('refuses moving a task to another agent, from a Full turn, and changes nothing', async () => {
    const mine = store.createTask({
      name: 'a-nightly',
      description: 'a',
      prompt: 'A’s work.',
      cron: '0 2 * * *',
      agentId: 'agent-a',
      filePath: path.join(scratch, 'none-a', 'SKILL.md'),
    });
    const theirs = bTask('acceptEdits');
    const tools = toolsOfA(await ranTurn('bypassPermissions'));
    const away = await call(tools, 'tasks_update', { id: mine.id, target: 'agent-b' });
    const toMe = await call(tools, 'tasks_update', { id: theirs.id, target: 'agent-a' });
    expect(away.isError).toBe(true);
    expect(toMe.isError).toBe(true);
    expect(store.getTask(mine.id)!.agentId).toBe('agent-a');
    expect(store.getTask(theirs.id)!.agentId).toBe('agent-b');
  });

  it('keeps both tools in the Tasks permission area, which the tool gate applies first', () => {
    expect(MCP_TOOL_TIERS.tasks_create.area).toBe('tasks');
    expect(MCP_TOOL_TIERS.tasks_update.area).toBe('tasks');
  });
});

describe('Must 4: the mode is capped at the target agent’s level', () => {
  it('caps a created task at a target set to Plan', async () => {
    levels.set(homeB, 'plan');
    const tools = toolsOfA(await ranTurn('bypassPermissions'));
    expect((await call(tools, 'tasks_create', { ...ARGS, target: 'agent-b' })).isError).toBe(false);
    expect(store.getTasks()[0]!.permissionMode).toBe('plan');
  });

  it('caps Bypass at a target below Full, and keeps it for a target at Full', async () => {
    levels.set(homeB, 'acceptEdits');
    expect(await capModeAtAgentLevel('bypassPermissions', homeB, CLAUDE_CODE_CAPABILITIES)).toBe(
      'acceptEdits'
    );
    levels.set(homeB, 'bypassPermissions');
    expect(await capModeAtAgentLevel('bypassPermissions', homeB, CLAUDE_CODE_CAPABILITIES)).toBe(
      'bypassPermissions'
    );
  });

  it('fails closed to the runtime default when the target’s level is unknown', async () => {
    expect(await capModeAtAgentLevel('bypassPermissions', homeB, CLAUDE_CODE_CAPABILITIES)).toBe(
      'default'
    );
    expect(await capModeAtAgentLevel('bypassPermissions', homeB, undefined)).toBe('default');
  });

  it('an edit by another agent cannot leave a task above its agent’s level', async () => {
    const theirs = bTask('bypassPermissions');
    levels.set(homeB, 'acceptEdits');
    const tools = toolsOfA(await ranTurn('bypassPermissions'));
    // Switching it on again changes no approved work, so only the cap can lower the mode here.
    const { isError } = await call(tools, 'tasks_update', { id: theirs.id, enabled: true });
    expect(isError).toBe(false);
    expect(store.getTask(theirs.id)!.permissionMode).toBe('acceptEdits');
  });

  it('a switch-off by another agent is never refused or changed by the cap', async () => {
    const theirs = bTask('bypassPermissions');
    levels.set(homeB, 'acceptEdits');
    const tools = toolsOfA(await ranTurn('bypassPermissions'));
    const { isError } = await call(tools, 'tasks_update', { id: theirs.id, enabled: false });
    expect(isError).toBe(false);
    expect(store.getTask(theirs.id)!.enabled).toBe(false);
  });

  it('an edit by another agent never raises a task, even for a Full target', async () => {
    const theirs = bTask('default');
    levels.set(homeB, 'bypassPermissions');
    const tools = toolsOfA(await ranTurn('bypassPermissions'));
    await call(tools, 'tasks_update', { id: theirs.id, cron: '0 6 * * *' });
    expect(store.getTask(theirs.id)!.permissionMode).toBe('default');
  });
});

describe('Must 3: each run records its creator and starts with its marks', () => {
  it('carries an outsider mark kept on the writer into the run', () => {
    const theirs = bTask('acceptEdits');
    store.approvals.recordCrossAgentWriter(theirs.id, {
      agentPath: homeA,
      sessionId: 'ses-made',
      marks: { outsider: true },
    });
    expect(creatorMarked(store, theirs)).toBe(true);
    expect(withCreatorMarks(store, theirs, { model: 'm' })).toEqual({
      model: 'm',
      carriedMarks: { outsider: true },
    });
  });

  it('a task no other agent wrote carries nothing', () => {
    const theirs = bTask('acceptEdits');
    expect(creatorMarked(store, theirs)).toBe(false);
    expect(withCreatorMarks(store, theirs, {})).toEqual({});
  });

  it('the run row keeps the writer, its chat and its marks; a person’s task records nobody', () => {
    const theirs = bTask('acceptEdits');
    store.approvals.recordCrossAgentWriter(theirs.id, {
      agentPath: homeA,
      sessionId: 'ses-made',
      marks: { outsider: true },
    });
    const run = store.createRun(theirs.id, 'scheduled');
    store.recordRunExecution(run.id, { runtime: 'claude-code' });
    expect(creatorOfRun(run.id)).toEqual({
      agentPath: homeA,
      sessionId: 'ses-made',
      marks: { outsider: true },
    });
    const personal = store.createTask({
      name: 'mine',
      description: 'm',
      prompt: 'Mine.',
      filePath: path.join(scratch, 'mine', 'SKILL.md'),
    });
    const own = store.createRun(personal.id, 'scheduled');
    store.recordRunExecution(own.id, { runtime: 'claude-code' });
    expect(creatorOfRun(own.id)).toBeNull();
  });

  it('a task made cross-agent from an unmarked turn records its creator with no marks', async () => {
    const sessionId = await ranTurn('bypassPermissions');
    await call(toolsOfA(sessionId), 'tasks_create', { ...ARGS, target: 'agent-b' });
    const task = store.getTasks()[0]!;
    expect(store.approvals.crossAgentWriterOf(task.id)).toEqual({
      agentPath: homeA,
      sessionId,
      marks: {},
    });
  });
});
