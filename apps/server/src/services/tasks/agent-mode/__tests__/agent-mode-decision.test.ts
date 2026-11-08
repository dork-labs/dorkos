/**
 * The decision behind `tasks.set_mode` and `tasks.approve` (DOR-3703), against
 * Security's ruling of 2026-11-02: who may skip the card, the ceiling, the
 * Don't-ask cap, marks, self-approval, other agents' tasks, and the defaults.
 *
 * @module services/tasks/agent-mode/__tests__/agent-mode-decision
 */
import { describe, it, expect } from 'vitest';
import type { Task } from '@dorkos/shared/types';
import type { TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import {
  PERMISSION_PRESETS,
  resolvePermission,
  type AgentPermissions,
  type PermissionConfigInput,
} from '@dorkos/shared/permissions';
import { levelOfMode } from '@dorkos/shared/permission-semantics';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import {
  decideAgentModeCall,
  type AgentModeCall,
  type AgentModeCaller,
  type AgentModeDecision,
  type AgentModeSources,
} from '../agent-mode-decision.js';
import type { ScheduleAgentEdits } from '../../approvals/task-approvals.js';

const A = '/tmp/dor3703-decision/agent-a';
const B = '/tmp/dor3703-decision/agent-b';
const C = '/tmp/dor3703-decision/agent-c';
const HOMES: Record<string, string> = { 'agent-a': A, 'agent-b': B, 'agent-c': C };

/** Each agent's unattended level, by its home; Trusted (Full autonomy) unless set. */
let levels: Record<string, string>;
let config: PermissionConfigInput;
let agentPermissions: AgentPermissions | undefined;
let parents: Record<string, string>;
/** The level each chat's latest turn really ran at, when one is recorded. */
let turns: Record<string, TurnPermissionLevel>;

function sources(): AgentModeSources {
  return {
    declaredModes: () => CLAUDE_CODE_CAPABILITIES.permissionModes,
    agentLevelMode: async (home) => levels[home] ?? 'bypassPermissions',
    agentPathOf: (id) => HOMES[id],
    readConfig: () => config,
    readAgentPermissions: async () => agentPermissions,
    startedBy: (sessionId) => parents[sessionId] ?? null,
    turnLevelOf: (sessionId) => turns[sessionId],
  };
}

function reset(): void {
  levels = {};
  config = { preset: 'trusted', defaults: { areas: {}, actions: {} } };
  agentPermissions = undefined;
  parents = {};
  // Every chat these tests call from ran a turn at Full; a chat with none is the S-B case.
  turns = Object.fromEntries(
    ['ses-a', 'ses-b', 'ses-child', 'ses-grandchild'].map((id) => [id, FULL_LEVEL])
  );
}

const FULL_LEVEL: TurnPermissionLevel = { asks: 'never', reach: 'everything' };

/** A task filed under agent A that agent B proposed and last changed, waiting. */
function task(over: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: 'sweep',
    prompt: 'sweep',
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

const EDITS: ScheduleAgentEdits = {
  lastEditedByAgentPath: B,
  lastEditedBySessionId: 'ses-b',
  agentApprovalKey: null,
};

/** Agent A, in its own chat. */
const IN_SESSION: AgentModeCaller = {
  structural: true,
  agentPath: A,
  sessionId: 'ses-a',
  marked: false,
};

function approve(body: Record<string, unknown> = {}, over: Partial<AgentModeCall> = {}) {
  return {
    door: 'update' as const,
    body: { status: 'active', ...body },
    task: task(),
    edits: EDITS,
    ...over,
  };
}

function setMode(
  mode: string,
  found: Task['permissionMode'] = 'default',
  over: Partial<Task> = {}
) {
  return {
    door: 'update' as const,
    body: { permissionMode: mode },
    task: task({ status: 'active', permissionMode: found, ...over }),
    edits: EDITS,
  };
}

async function decide(call: AgentModeCall, caller: AgentModeCaller = IN_SESSION) {
  return decideAgentModeCall(call, caller, sources());
}

function stateOf(decision: AgentModeDecision): string {
  return decision.kind === 'decided' ? decision.state : decision.kind;
}

/** Set both actions to Allowed for everyone, the strongest setting a person can choose. */
function allowBoth(): void {
  config.defaults.actions['tasks.set_mode'] = 'allowed';
  config.defaults.actions['tasks.approve'] = 'allowed';
}

describe('tasks.set_mode and tasks.approve: the defaults', () => {
  it('asks for an approval on every preset until the action itself is Allowed', async () => {
    for (const preset of [null, ...PERMISSION_PRESETS]) {
      reset();
      config.preset = preset;
      expect(stateOf(await decide(approve())), `approve on ${preset}`).toBe('ask');
      // Even an explicit area-level Allowed is not enough for an approval.
      config.defaults.areas.tasks = 'allowed';
      expect(stateOf(await decide(approve())), `approve, area allowed, ${preset}`).toBe('ask');
      allowBoth();
      expect(stateOf(await decide(approve())), `approve, action allowed, ${preset}`).toBe(
        'allowed'
      );
    }
  });

  it('lets an agent set its own task’s mode in its own chat by default, as the Tasks area says', async () => {
    for (const preset of [null, ...PERMISSION_PRESETS]) {
      reset();
      config.preset = preset;
      const expected = preset === 'careful' || preset === 'balanced' ? 'ask' : 'allowed';
      expect(stateOf(await decide(setMode('dontAsk'))), `set_mode on ${preset}`).toBe(expected);
    }
    // A person can still turn it to Ask or Blocked for an agent.
    reset();
    agentPermissions = { actions: { 'tasks.set_mode': 'ask' } };
    expect(stateOf(await decide(setMode('dontAsk')))).toBe('ask');
    agentPermissions = { actions: { 'tasks.set_mode': 'blocked' } };
    expect(stateOf(await decide(setMode('dontAsk')))).toBe('blocked');
  });

  it('resolve through the shared resolver: an area-level Allowed asks, the action’s own allows', () => {
    const base = {
      area: 'tasks' as const,
      tier: 'act' as const,
      consent: 'standing-grant' as const,
    };
    const trusted = { preset: 'trusted' as const, defaults: { areas: {}, actions: {} } };
    expect(
      resolvePermission({ ...base, actionId: 'tasks.approve', config: trusted })
    ).toMatchObject({ state: 'ask', destructiveAsk: true });
    expect(
      resolvePermission({
        ...base,
        actionId: 'tasks.approve',
        config: trusted,
        agent: { actions: { 'tasks.approve': 'allowed' } },
      }).state
    ).toBe('allowed');
    expect(
      resolvePermission({
        ...base,
        actionId: 'tasks.approve',
        config: {
          preset: 'trusted',
          defaults: { areas: {}, actions: { 'tasks.approve': 'blocked' } },
        },
      }).state
    ).toBe('blocked');
  });

  it('follows an agent’s own setting, and a Blocked one refuses at the gate', async () => {
    reset();
    agentPermissions = { actions: { 'tasks.approve': 'allowed' } };
    expect(stateOf(await decide(approve()))).toBe('allowed');
    agentPermissions = { actions: { 'tasks.approve': 'blocked' } };
    expect(stateOf(await decide(approve()))).toBe('blocked');
  });
});

describe('who may skip the card (ruling 1)', () => {
  it('asks a token even at Allowed; only an agent in its own chat is allowed', async () => {
    reset();
    allowBoth();
    const token: AgentModeCaller = { structural: false, agentPath: A, marked: false };
    const decision = await decide(setMode('dontAsk'), token);
    expect(stateOf(decision)).toBe('ask');
    expect(decision.kind === 'decided' && decision.asks).toContain('not-structural');
    expect(stateOf(await decide(setMode('dontAsk')))).toBe('allowed');
  });

  it('holds a caller DorkOS cannot name to the lowest level, and asks it even there', async () => {
    reset();
    allowBoth();
    const unnamed: AgentModeCaller = { structural: false, marked: true };
    // On a Full agent's task, Bypass is refused, not carded: the caller adds the lowest level.
    expect(await decide(setMode('bypassPermissions', 'bypassPermissions'), unnamed)).toMatchObject({
      kind: 'refuse',
      body: { code: 'above_ceiling', highestAllowed: 'plan' },
    });
    expect(await decide(setMode('dontAsk'), unnamed)).toMatchObject({
      kind: 'refuse',
      body: { code: 'above_ceiling' },
    });
    // Reading only fits, and still asks.
    expect(stateOf(await decide(setMode('plan'), unnamed))).toBe('ask');
  });

  it('refuses an approval from a caller with no chat, since its chain cannot be read', async () => {
    reset();
    allowBoth();
    for (const caller of [
      { structural: false, agentPath: A, marked: false },
      { structural: false, marked: true },
      { ...IN_SESSION, sessionId: undefined },
    ] as AgentModeCaller[]) {
      expect(await decide(approve(), caller)).toMatchObject({
        kind: 'refuse',
        body: { code: 'lineage_unknown' },
      });
    }
  });
});

describe('the ceiling (ruling 3)', () => {
  it('never refuses a mode on another agent’s task: a person decides it on a card, at any mode', async () => {
    reset();
    allowBoth();
    levels[A] = 'bypassPermissions';
    levels[B] = 'default';
    for (const mode of ['bypassPermissions', 'acceptEdits', 'plan'] as const) {
      const decision = await decide(setMode(mode, 'acceptEdits', { agentId: 'agent-b' }));
      expect(stateOf(decision), mode).toBe('ask');
      expect(decision.kind === 'decided' && decision.asks).toContain('other-agent');
    }
  });

  it('caps the caller’s own level too', async () => {
    reset();
    levels[A] = 'default';
    expect(await decide(setMode('acceptEdits', 'acceptEdits'))).toMatchObject({
      kind: 'refuse',
      body: { code: 'above_ceiling' },
    });
  });

  it('lets a Bypass agent set Bypass on its own task, in its own unmarked chat', async () => {
    reset();
    levels[A] = 'bypassPermissions';
    expect(stateOf(await decide(setMode('bypassPermissions', 'acceptEdits')))).toBe('allowed');
    // Within the ceiling a raise is the agent's to make (Dorian's rule, Nov 2).
    expect(stateOf(await decide(setMode('acceptEdits', 'default')))).toBe('allowed');
  });

  it('refuses Bypass from an agent at Accept edits, naming the highest it can set', async () => {
    reset();
    allowBoth();
    levels[A] = 'acceptEdits';
    expect(await decide(setMode('bypassPermissions', 'acceptEdits'))).toMatchObject({
      kind: 'refuse',
      body: { code: 'above_ceiling', highestAllowed: 'acceptEdits' },
    });
  });

  it('asks before an approval arms a mode looser than Don’t ask, Bypass included', async () => {
    reset();
    allowBoth();
    for (const mode of ['acceptEdits', 'bypassPermissions'] as const) {
      const decision = await decide(approve({}, { task: task({ permissionMode: mode }) }));
      expect(stateOf(decision), mode).toBe('ask');
      expect(decision.kind === 'decided' && decision.asks).toContain('looser-than-dont-ask');
    }
    expect(stateOf(await decide(approve()))).toBe('allowed');
  });

  it('refuses a mode nobody declared', async () => {
    reset();
    expect(await decide(setMode('everything'))).toMatchObject({
      kind: 'refuse',
      body: { code: 'unknown_mode' },
    });
  });
});

describe('marks (ruling 4)', () => {
  it('asks from a marked turn even at Allowed, and before arming a task whose words came from outside', async () => {
    reset();
    allowBoth();
    const marked = { ...IN_SESSION, marked: true };
    expect(stateOf(await decide(approve(), marked))).toBe('ask');
    expect(stateOf(await decide(setMode('dontAsk'), marked))).toBe('ask');
    const outsiders = task({ originMarks: { outsider: true } } as Partial<Task>);
    expect(stateOf(await decide(approve({}, { task: outsiders })))).toBe('ask');
  });

  it('caps a marked turn at Don’t ask, even for a Bypass agent', async () => {
    reset();
    allowBoth();
    const marked = { ...IN_SESSION, marked: true };
    expect(await decide(setMode('acceptEdits', 'acceptEdits'), marked)).toMatchObject({
      kind: 'refuse',
      body: { code: 'above_ceiling', highestAllowed: 'default' },
    });
    expect(stateOf(await decide(setMode('acceptEdits', 'acceptEdits')))).toBe('allowed');
  });
});

describe('a caller resolved through a linked worktree (C2)', () => {
  it('asks above Default, even for a Bypass agent at Allowed, and not at or below it', async () => {
    reset();
    allowBoth();
    const worktree: AgentModeCaller = { ...IN_SESSION, resolved: 'worktree' };
    for (const mode of ['bypassPermissions', 'acceptEdits'] as const) {
      const decision = await decide(setMode(mode, 'bypassPermissions'), worktree);
      expect(stateOf(decision), mode).toBe('ask');
      expect(decision.kind === 'decided' && decision.asks).toContain('linked-worktree');
    }
    expect(stateOf(await decide(setMode('default', 'bypassPermissions'), worktree))).toBe(
      'allowed'
    );
  });
});

describe('no self-approval (ruling 5)', () => {
  it('refuses the agent that made the task, at Allowed', async () => {
    reset();
    allowBoth();
    const made = task({ proposedByAgentPath: A, proposedBySessionId: 'ses-old' });
    const decision = await decide(
      approve({}, { task: made, edits: { ...EDITS, lastEditedByAgentPath: C } })
    );
    expect(decision).toMatchObject({ kind: 'refuse', body: { code: 'self_approval' } });
  });

  it('refuses the agent that changed it last', async () => {
    reset();
    allowBoth();
    const edits = { ...EDITS, lastEditedByAgentPath: A, lastEditedBySessionId: 'ses-x' };
    expect(await decide(approve({}, { edits }))).toMatchObject({
      kind: 'refuse',
      body: { code: 'self_approval' },
    });
  });

  it('refuses a spin-off approving its parent’s task, and a parent approving its spin-off’s', async () => {
    reset();
    allowBoth();
    // Agent B's chat ses-b started a spin-off, ses-child, that runs as agent C.
    parents['ses-child'] = 'ses-b';
    const spinOff: AgentModeCaller = {
      structural: true,
      agentPath: C,
      sessionId: 'ses-child',
      marked: false,
    };
    const owned = task({ agentId: 'agent-c' });
    expect(await decide(approve({}, { task: owned }), spinOff)).toMatchObject({
      kind: 'refuse',
      body: { code: 'self_approval' },
    });
    // Two levels down still counts.
    parents['ses-grandchild'] = 'ses-child';
    const deeper = { ...spinOff, sessionId: 'ses-grandchild' };
    expect(await decide(approve({}, { task: owned }), deeper)).toMatchObject({ kind: 'refuse' });
    // The parent approving a task its spin-off made.
    const madeBySpinOff = task({ proposedByAgentPath: C, proposedBySessionId: 'ses-child' });
    const parent: AgentModeCaller = {
      structural: true,
      agentPath: A,
      sessionId: 'ses-b',
      marked: false,
    };
    const edits = { ...EDITS, lastEditedByAgentPath: C, lastEditedBySessionId: 'ses-child' };
    expect(await decide(approve({}, { task: madeBySpinOff, edits }), parent)).toMatchObject({
      kind: 'refuse',
      body: { code: 'self_approval' },
    });
  });

  it('refuses every agent when DorkOS has no record of the last editor', async () => {
    reset();
    allowBoth();
    for (const edits of [null, { ...EDITS, lastEditedByAgentPath: null }]) {
      expect(await decide(approve({}, { edits }))).toMatchObject({
        kind: 'refuse',
        body: { code: 'self_approval' },
      });
    }
  });

  it('refuses a new task that names its own status, and an approval sent with other changes', async () => {
    reset();
    expect(
      await decide({
        door: 'create',
        body: { status: 'active', permissionMode: 'default' },
        target: 'agent-a',
      })
    ).toMatchObject({ kind: 'refuse', body: { code: 'self_approval' } });
    expect(await decide(approve({ prompt: 'something else' }))).toMatchObject({
      kind: 'refuse',
      body: { code: 'approve_alone' },
    });
    expect(await decide(approve({ status: 'paused' }))).toMatchObject({ kind: 'refuse' });
  });
});

describe('another agent’s task (ruling 6)', () => {
  it('asks at Allowed; Allowed covers the caller’s own tasks only', async () => {
    reset();
    allowBoth();
    const others = task({ agentId: 'agent-b', proposedByAgentPath: C });
    const edits = { ...EDITS, lastEditedByAgentPath: C };
    const decision = await decide(approve({}, { task: others, edits }));
    expect(stateOf(decision)).toBe('ask');
    expect(decision.kind === 'decided' && decision.asks).toEqual(['other-agent']);
    expect(stateOf(await decide(setMode('dontAsk', 'default', { agentId: 'agent-b' })))).toBe(
      'ask'
    );
  });
});

describe('nothing to decide', () => {
  it('answers none for a call that names neither field', async () => {
    reset();
    expect(
      await decide({ door: 'update', body: { prompt: 'x' }, task: task(), edits: EDITS })
    ).toEqual({
      kind: 'none',
    });
  });
});

describe('the chain must be readable (S1)', () => {
  it('refuses when the last editor or the maker names no chat', async () => {
    reset();
    allowBoth();
    expect(
      await decide(approve({}, { edits: { ...EDITS, lastEditedBySessionId: null } }))
    ).toMatchObject({ kind: 'refuse', body: { code: 'lineage_unknown' } });
    expect(await decide(approve({}, { task: task({ proposedBySessionId: null }) }))).toMatchObject({
      kind: 'refuse',
      body: { code: 'lineage_unknown' },
    });
  });
});

describe('the caller’s level is its turn’s real level (S3)', () => {
  it('caps a chat held below its agent’s launch level at the held level', async () => {
    reset();
    allowBoth();
    // Agent A launches at Full, but this chat's turn ran at Default.
    turns['ses-a'] = { asks: 'always', reach: 'edit' };
    expect(await decide(setMode('acceptEdits', 'acceptEdits'))).toMatchObject({
      kind: 'refuse',
      body: { code: 'above_ceiling' },
    });
    // A chat held to reading only cannot even land Don't ask.
    turns['ses-a'] = { asks: 'always', reach: 'read' };
    expect(await decide(setMode('dontAsk'))).toMatchObject({
      kind: 'refuse',
      body: { code: 'above_ceiling', highestAllowed: 'plan' },
    });
  });
});

describe('a person’s decline stands (S7)', () => {
  it('refuses an agent approving a task a person declined', async () => {
    reset();
    allowBoth();
    expect(
      await decide(approve({}, { task: task({ declined: true } as Partial<Task>) }))
    ).toMatchObject({
      kind: 'refuse',
      body: { code: 'declined' },
    });
  });
});

describe('a new task under another agent (N3)', () => {
  it('is refused before any card, even when the mode would be allowed', async () => {
    reset();
    allowBoth();
    const create = {
      door: 'create' as const,
      body: { permissionMode: 'dontAsk' },
      target: 'agent-b',
    };
    expect(await decide(create)).toMatchObject({
      kind: 'refuse',
      body: { code: 'not_your_agent' },
    });
    expect(stateOf(await decide({ ...create, target: 'agent-a' }))).toBe('allowed');
  });
});

describe('a chat with no recorded turn level (S-B)', () => {
  it('gets the lowest level, and finds a level kept under the chat’s other id', async () => {
    reset();
    allowBoth();
    delete turns['ses-a'];
    expect(await decide(setMode('dontAsk'))).toMatchObject({
      kind: 'refuse',
      body: { code: 'above_ceiling', highestAllowed: 'plan' },
    });
    // The level was recorded under the chat's first id before it was rekeyed.
    turns['ses-first'] = FULL_LEVEL;
    const rekeyed = { ...IN_SESSION, turnSessionIds: ['ses-a', 'ses-first'] };
    expect(stateOf(await decide(setMode('dontAsk'), rekeyed))).toBe('allowed');
  });
});

describe('modes looser than Don’t ask (M-A)', () => {
  it('marks a mode above Don’t ask so the door can hold it for a person', async () => {
    reset();
    const above = await decide(setMode('bypassPermissions', 'acceptEdits'));
    expect(above).toMatchObject({ kind: 'decided', state: 'allowed', aboveDontAsk: true });
    expect(await decide(setMode('dontAsk'))).toMatchObject({ aboveDontAsk: false });
  });
});

describe('a chat kept under more than one id (round 3 nit)', () => {
  it('is held to the strictest level recorded under any of them, not the first found', async () => {
    reset();
    allowBoth();
    turns['ses-first'] = levelOfMode(CLAUDE_CODE_CAPABILITIES.permissionModes, 'default')!;
    const rekeyed = { ...IN_SESSION, turnSessionIds: ['ses-first'] };
    expect(await decide(setMode('bypassPermissions'), rekeyed)).toMatchObject({
      kind: 'refuse',
      body: { code: 'above_ceiling' },
    });
    expect(stateOf(await decide(setMode('bypassPermissions')))).toBe('allowed');
  });
});

describe('a mode a person must approve travels alone (M1, round 3)', () => {
  const mixed = () => ({
    door: 'update' as const,
    body: { cron: '*/5 * * * *', permissionMode: 'bypassPermissions' },
    task: task({ status: 'active', permissionMode: 'dontAsk', proposedByAgentPath: null }),
    edits: EDITS,
  });

  it('refuses a carded mode sent with other changes, before any card', async () => {
    reset();
    config.defaults.actions['tasks.set_mode'] = 'ask';
    expect(await decide(mixed())).toMatchObject({ kind: 'refuse', body: { code: 'mode_alone' } });
    // The mode alone is carded as usual.
    expect(stateOf(await decide(setMode('bypassPermissions', 'dontAsk')))).toBe('ask');
  });

  it('lets the same call through where no card is raised', async () => {
    reset();
    expect(stateOf(await decide(mixed()))).toBe('allowed');
  });
});

describe('the task’s own agent vouching in place of a person (Nov 3 ruling)', () => {
  /** Agent A's own live task, which agent A proposed. */
  const own = (over: Partial<Task> = {}) =>
    setMode('bypassPermissions', 'acceptEdits', { proposedByAgentPath: A, ...over });
  /** Agent A in its own home folder: the folder vouches for it. */
  const HOME: AgentModeCaller = { ...IN_SESSION, resolved: 'home' };

  it('vouches from its own home chat, in an unmarked turn', async () => {
    reset();
    expect(await decide(own(), HOME)).toMatchObject({
      kind: 'decided',
      vouched: true,
      raise: true,
    });
  });

  it('does not vouch for content an outsider wrote, nor for a task another agent proposed', async () => {
    reset();
    expect(await decide(own({ originMarks: { outsider: true } }), HOME)).toMatchObject({
      vouched: false,
    });
    expect(await decide(own({ proposedByAgentPath: B }), HOME)).toMatchObject({ vouched: false });
  });

  it('does not vouch from a chat its folder does not vouch for, or for a scheduled run’s raise', async () => {
    reset();
    expect(await decide(own(), { ...HOME, resolved: 'worktree' })).toMatchObject({
      vouched: false,
    });
    // MUST-H: nothing to vouch for, because a scheduled run's raise is refused outright.
    expect(await decide(own(), { ...HOME, scheduledRun: true })).toMatchObject({
      kind: 'refuse',
      body: { code: 'scheduled_raise' },
    });
  });
});
