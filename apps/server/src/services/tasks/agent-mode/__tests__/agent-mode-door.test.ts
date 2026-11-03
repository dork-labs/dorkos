/**
 * The door's second reading of an agent's mode or approval (DOR-3703): it never
 * grants on its own (S4), and a person's yes covers only the task as it was
 * when they were asked (M1).
 *
 * @module services/tasks/agent-mode/__tests__/agent-mode-door
 */
import { describe, it, expect } from 'vitest';
import type { Task } from '@dorkos/shared/types';
import type { PermissionConfigInput } from '@dorkos/shared/permissions';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { noteEscalatedGrant } from '../../../core/capabilities/tool-call-escalation.js';
import type { GatedAction } from '../../../core/capabilities/tier-enforcement.js';
import { settleAgentModeCall } from '../agent-mode-door.js';
import { agentModeChangeOf } from '../agent-mode-change.js';
import { escalationFor } from '../agent-mode-escalation.js';
import type { AgentModeCaller, AgentModeSources } from '../agent-mode-decision.js';

const A = '/tmp/dor3703-door/agent-a';
const B = '/tmp/dor3703-door/agent-b';

let config: PermissionConfigInput;
const sources: AgentModeSources = {
  declaredModes: () => CLAUDE_CODE_CAPABILITIES.permissionModes,
  agentLevelMode: async () => 'bypassPermissions',
  agentPathOf: (id) => ({ 'agent-a': A, 'agent-b': B })[id],
  readConfig: () => config,
  readAgentPermissions: async () => undefined,
  startedBy: () => null,
  // The caller's chat ran a turn at Full.
  turnLevelOf: () => ({ asks: 'never', reach: 'everything' }),
};

const CALLER: AgentModeCaller = {
  structural: true,
  agentPath: A,
  sessionId: 'ses-a',
  marked: false,
};

function waiting(over: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: 'sweep',
    prompt: 'sweep the backlog',
    cron: '0 3 * * *',
    timezone: 'UTC',
    agentId: 'agent-a',
    permissionMode: 'default',
    status: 'pending_approval',
    runtime: null,
    model: null,
    account: null,
    filePath: '',
    proposedByAgentPath: B,
    proposedBySessionId: 'ses-b',
    ...over,
  } as Task;
}

const EDITS = { lastEditedByAgentPath: B, lastEditedBySessionId: 'ses-b', agentApprovalKey: null };

/** The gate's note for one input, as `runGate` writes it. */
function note(input: object, actionId: string, via: 'card' | 'allowed', change?: string) {
  noteEscalatedGrant(
    input,
    { action: { id: actionId } as GatedAction, permission: null, ...(change ? { change } : {}) },
    via === 'card'
      ? { outcome: 'allowed', approval: { via: 'approval', approvalId: 'ap-1' } }
      : { outcome: 'allowed' },
    'session'
  );
}

function settle(input: object, task: Task) {
  return settleAgentModeCall(
    { door: 'update', body: { status: 'active' }, input, task, edits: EDITS, caller: CALLER },
    undefined,
    sources
  );
}

const ALLOWED: PermissionConfigInput = {
  preset: 'trusted',
  defaults: { areas: {}, actions: { 'tasks.approve': 'allowed' } },
};
const DEFAULT: PermissionConfigInput = { preset: 'trusted', defaults: { areas: {}, actions: {} } };

/** The change text the gate would have bound for this task. */
function changeFor(task: Task) {
  return agentModeChangeOf(
    { door: 'update', body: { status: 'active' }, task },
    { mode: task.permissionMode, previousMode: task.permissionMode },
    undefined,
    CALLER.agentPath
  );
}

describe('the door never grants on its own (S4)', () => {
  it('refuses a call the gate did not decide, even when its own reading says Allowed', async () => {
    config = ALLOWED;
    const result = await settle({ id: 'task-1', status: 'active' }, waiting());
    expect(result.refusal).toMatchObject({ code: 'needs_a_person' });
  });

  it('refuses a call the gate let through as the tool, not as the approval', async () => {
    config = ALLOWED;
    const input = { id: 'task-1', status: 'active' };
    note(input, 'tasks_update', 'allowed');
    expect((await settle(input, waiting())).refusal).toMatchObject({ code: 'needs_a_person' });
  });

  it('refuses when the gate allowed it but the door now reads Ask, without a card', async () => {
    config = DEFAULT;
    const input = { id: 'task-1', status: 'active' };
    note(input, 'tasks.approve', 'allowed', changeFor(waiting()));
    expect((await settle(input, waiting())).refusal).toMatchObject({ code: 'needs_a_person' });
  });

  it('grants a call the gate allowed as this action, on the same task', async () => {
    config = ALLOWED;
    const input = { id: 'task-1', status: 'active' };
    note(input, 'tasks.approve', 'allowed', changeFor(waiting()));
    const result = await settle(input, waiting());
    expect(result.grant).toMatchObject({ via: 'allowed', decision: { approves: true } });
    expect(result.grant?.snapshot).toEqual(expect.any(String));
  });
});

describe('a yes covers the task as it was (M1)', () => {
  it('refuses a card granted for a prompt that has since changed', async () => {
    config = DEFAULT;
    const input = { id: 'task-1', status: 'active' };
    note(input, 'tasks.approve', 'card', changeFor(waiting()));
    const rewritten = waiting({ prompt: 'delete everything' });
    expect((await settle(input, rewritten)).refusal).toMatchObject({ code: 'task_changed' });
    // The same task it was asked about is granted.
    const fresh = { id: 'task-1', status: 'active' };
    note(fresh, 'tasks.approve', 'card', changeFor(waiting()));
    expect((await settle(fresh, waiting())).grant).toMatchObject({
      via: 'card',
      approvalId: 'ap-1',
    });
  });
});

describe('a call the gate refuses reaches the tool as the tool, never as the action (N-a)', () => {
  it('is let through under the tool’s own id, and the door refuses that note', async () => {
    config = ALLOWED;
    const tool = { id: 'tasks_update', title: 'Change a scheduled task' } as GatedAction;
    const escalation = escalationFor(
      { kind: 'refuse', body: { error: 'x', code: 'self_approval', message: 'x' } },
      tool,
      null
    );
    expect(escalation).toMatchObject({
      action: { id: 'tasks_update' },
      permission: { state: 'allowed' },
    });
    // Even if the decision had come out Allowed by now, that note grants nothing.
    const input = { id: 'task-1', status: 'active' };
    note(input, escalation!.action.id, 'allowed', changeFor(waiting()));
    expect((await settle(input, waiting())).refusal).toMatchObject({ code: 'needs_a_person' });
  });
});
