/**
 * The hub's side of the tool bridge (DOR-2939 part 6): every rule a bridged
 * call meets before it runs, each with a case that fails if the rule goes.
 *
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RelayToolCallOutcome,
  RelayToolSummary,
} from '@dorkos/shared/session-relay-agent-computer';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  agentIsReadingOutsider,
  resetLiveOutsiderTurns,
} from '../../turn-power/live-outsider-turns.js';
import { createBridgedToolRateLimits } from '../bridge-guards.js';
import {
  handleBridgedToolCall,
  handleBridgedToolList,
  type BridgedAgent,
  type BridgedToolDeps,
  type BridgedToolRun,
  type BridgedTurn,
} from '../bridged-tool-call.js';
import { HUB_SETUP_REFUSAL, type BridgeAction } from '../hub-setup-tools.js';

const COMPUTER = 'cc-1';
const SCOUT = '01KJXYKJYW4N8QGQ5W4GB6YM9J';
const DORKBOT = '01KJXYKJYW4N8QGQ5W4GB6YM9K';
const SESSION = '3f1c2b7a-8d4e-4f6a-9b0c-1d2e3f4a5b6c';
const DORKBOT_SESSION = '4f1c2b7a-8d4e-4f6a-9b0c-1d2e3f4a5b6c';

const ACTIONS: Record<string, BridgeAction> = {
  post_to_room: {
    id: 'rooms.post',
    toolName: 'post_to_room',
    title: 'Post',
    tier: 'act',
    area: null,
  },
  read_room_history: {
    id: 'rooms.read_history',
    toolName: 'read_room_history',
    title: 'Read',
    tier: 'observe',
    area: null,
  },
  tasks_create: {
    id: 'tasks_create',
    toolName: 'tasks_create',
    title: 'T',
    tier: 'act',
    area: 'tasks',
  },
  marketplace_install: {
    id: 'marketplace.install',
    toolName: 'marketplace_install',
    title: 'Install',
    tier: 'act',
    area: 'packages',
  },
  mesh_unregister: {
    id: 'mesh_unregister',
    toolName: 'mesh_unregister',
    title: 'Remove',
    tier: 'destructive',
    area: 'agents',
  },
  request_permission: {
    id: 'permissions.request_access',
    toolName: 'request_permission',
    title: 'Ask',
    tier: 'act',
    area: null,
  },
  local_browser_act: {
    id: 'local_browser.act',
    toolName: 'local_browser_act',
    title: 'Drive',
    tier: 'act',
    area: null,
  },
};

const AGENTS: Record<string, BridgedAgent> = {
  [SCOUT]: { agentPath: '/hub/agents/scout', displayName: 'Scout', isSystem: false },
  [DORKBOT]: { agentPath: '/hub/agents/dorkbot', displayName: 'DorkBot', isSystem: true },
};

const ownerTurn = (agentId: string): BridgedTurn => ({
  agentId,
  tier: 'owner',
  permissionMode: 'default',
  outsiderCapped: false,
});

let turns: Record<string, BridgedTurn>;
let granted: boolean;
let calls: (BridgedToolRun & { tool: string; input: unknown })[];
let answer: () => Promise<RelayToolCallOutcome>;
let deps: BridgedToolDeps;

beforeEach(() => {
  resetLiveOutsiderTurns();
  turns = { [SESSION]: ownerTurn(SCOUT), [DORKBOT_SESSION]: ownerTurn(DORKBOT) };
  granted = false;
  calls = [];
  answer = async () => ({ ok: true, output: { done: true } });
  deps = {
    agentWorksOn: (agentId) => (AGENTS[agentId] ? COMPUTER : null),
    turnFor: (sessionId) => turns[sessionId] ?? null,
    agent: (agentId) => AGENTS[agentId] ?? null,
    actionForTool: (tool) => ACTIONS[tool] ?? null,
    dorkbotSetupGranted: () => granted,
    limits: createBridgedToolRateLimits(),
    runner: {
      list: async () => [],
      call: async (run) => {
        calls.push(run);
        return answer();
      },
    },
  };
});

const call = (over: Partial<Parameters<typeof handleBridgedToolCall>[0]> = {}) =>
  handleBridgedToolCall(
    {
      computerId: COMPUTER,
      agentId: SCOUT,
      sessionId: SESSION,
      tool: 'post_to_room',
      input: {},
      ...over,
    },
    deps
  );

describe('what the hub checks before it runs anything', () => {
  it('runs a normal tool as the agent, under the agent-computer caller, never a person', async () => {
    expect(await call({ input: { roomId: 'r1', text: 'hi' } })).toEqual({
      ok: true,
      output: { done: true },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      caller: 'agent-computer',
      identity: { agentPath: '/hub/agents/scout', displayName: 'Scout' },
      sessionId: SESSION,
      tool: 'post_to_room',
      input: { roomId: 'r1', text: 'hi' },
    });
    expect(calls[0]).not.toHaveProperty('userId');
    expect(calls[0]).not.toHaveProperty('trusted');
  });

  it('refuses an agent that does not work on this computer', async () => {
    expect(await call({ computerId: 'cc-2' })).toMatchObject({
      ok: false,
      code: 'not_this_computer',
    });
    expect(await call({ agentId: '01KJXYKJYW4N8QGQ5W4GB6YM9Z' })).toMatchObject({
      ok: false,
      code: 'not_this_computer',
    });
    expect(calls).toEqual([]);
  });

  it('refuses a session the hub did not start, never falling back to the agent`s own level', async () => {
    expect(await call({ sessionId: '5f1c2b7a-8d4e-4f6a-9b0c-1d2e3f4a5b6c' })).toMatchObject({
      ok: false,
      code: 'unknown_session',
    });
    expect(calls).toEqual([]);
  });

  it('refuses a session the hub started for another agent', async () => {
    expect(await call({ sessionId: DORKBOT_SESSION })).toMatchObject({
      ok: false,
      code: 'unknown_session',
    });
  });

  it('refuses a tool that does not exist, and one that runs on the computer itself', async () => {
    expect(await call({ tool: 'nope' })).toMatchObject({ ok: false, code: 'unknown_tool' });
    expect(await call({ tool: 'local_browser_act' })).toMatchObject({
      ok: false,
      code: 'runs_on_computer',
    });
    expect(calls).toEqual([]);
  });
});

describe('setup tools', () => {
  it('are refused without the grant, to DorkBot as well', async () => {
    const refused = await call({
      agentId: DORKBOT,
      sessionId: DORKBOT_SESSION,
      tool: 'marketplace_install',
    });
    expect(refused).toEqual({ ok: false, code: 'setup_refused', message: HUB_SETUP_REFUSAL });
  });

  it('are refused to any agent but DorkBot, even with the grant', async () => {
    granted = true;
    expect(await call({ tool: 'marketplace_install' })).toMatchObject({ code: 'setup_refused' });
    expect(calls).toEqual([]);
  });

  it('run for DorkBot with the grant, and a destructive one still goes to the gate unapproved', async () => {
    granted = true;
    await call({ agentId: DORKBOT, sessionId: DORKBOT_SESSION, tool: 'marketplace_install' });
    await call({
      agentId: DORKBOT,
      sessionId: DORKBOT_SESSION,
      tool: 'mesh_unregister',
      input: { agentId: SCOUT },
    });
    expect(calls.map((run) => run.tool)).toEqual(['marketplace_install', 'mesh_unregister']);
    // Exactly what was sent: no approval token is added on the way.
    expect(calls[1]!.input).toEqual({ agentId: SCOUT });
  });

  it('are refused to DorkBot, grant or not, in a turn that read an outsider`s words', async () => {
    granted = true;
    turns[DORKBOT_SESSION] = { ...ownerTurn(DORKBOT), outsiderCapped: true };
    expect(
      await call({ agentId: DORKBOT, sessionId: DORKBOT_SESSION, tool: 'marketplace_install' })
    ).toMatchObject({ code: 'setup_refused' });
  });

  it('cannot be reached by asking for access to one', async () => {
    const asked = await call({
      tool: 'request_permission',
      input: { action: 'mcp__dorkos__marketplace_install', arguments: {}, reason: 'x' },
    });
    expect(asked).toMatchObject({ ok: false, code: 'setup_refused' });
    expect(calls).toEqual([]);
  });
});

describe('the hub`s record of the turn', () => {
  it('holds a teammate-tier turn to the teammate table', async () => {
    turns[SESSION] = { ...ownerTurn(SCOUT), tier: 'teammate', roomId: 'r1' };
    expect(await call({ tool: 'tasks_create', input: { name: 'x' } })).toMatchObject({
      ok: false,
      code: 'teammate_tier',
    });
    expect(await call({ input: { roomId: 'r2', text: 'hi' } })).toMatchObject({
      code: 'teammate_tier',
    });
    expect(await call({ input: { roomId: 'r1', text: 'hi' } })).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it('runs reads only in a read-only turn', async () => {
    turns[SESSION] = { ...ownerTurn(SCOUT), permissionMode: 'plan' };
    expect(await call({ input: { roomId: 'r1', text: 'hi' } })).toMatchObject({
      ok: false,
      code: 'read_only_turn',
    });
    expect(await call({ tool: 'read_room_history', input: { roomId: 'r1' } })).toMatchObject({
      ok: true,
    });
  });

  it('runs a capped turn counted as reading an outsider`s words, so the gate asks', async () => {
    const seen: boolean[] = [];
    answer = async () => {
      seen.push(agentIsReadingOutsider('/hub/agents/scout'));
      return { ok: true, output: null };
    };
    await call();
    turns[SESSION] = { ...ownerTurn(SCOUT), outsiderCapped: true };
    await call();
    expect(seen).toEqual([false, true]);
    // Counted for the call only.
    expect(agentIsReadingOutsider('/hub/agents/scout')).toBe(false);
  });
});

describe('rate limits', () => {
  it('caps calls per turn', async () => {
    deps.limits = createBridgedToolRateLimits({ perTurn: 3, perComputer: 100 });
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await call());
    expect(results.map((result) => result.ok)).toEqual([true, true, true, false, false]);
    expect(results[4]).toMatchObject({ ok: false, code: 'rate_limited' });
    // Another turn on the same computer still has its own budget.
    expect(await call({ agentId: DORKBOT, sessionId: DORKBOT_SESSION })).toMatchObject({
      ok: true,
    });
  });

  it('caps calls per computer, across its turns, before reading anything else', async () => {
    deps.limits = createBridgedToolRateLimits({ perTurn: 100, perComputer: 2 });
    await call();
    await call({ agentId: DORKBOT, sessionId: DORKBOT_SESSION });
    expect(await call({ computerId: COMPUTER, tool: 'nope' })).toMatchObject({
      code: 'rate_limited',
    });
    // Another computer is counted apart.
    expect(await call({ computerId: 'cc-2' })).toMatchObject({ code: 'not_this_computer' });
  });
});

describe('what crosses back', () => {
  const PATHY = '/Users/dorian/.dork/hub/setup-grants.json';

  it('never a thrown error, its path or its stack', async () => {
    answer = async () => {
      throw new Error(`EACCES: permission denied, open '${PATHY}'`);
    };
    const failed = await call();
    expect(failed).toEqual({
      ok: false,
      code: 'tool_failed',
      message: 'The tool failed before it could answer.',
    });
    expect(JSON.stringify(failed)).not.toContain('/Users');
  });

  it('never a tool`s own failure sentence, or a code that is not plain', async () => {
    answer = async () => ({ ok: false, code: 'ENOENT:/etc/x', message: `Cannot read ${PATHY}` });
    const failed = await call();
    expect(failed).toEqual({
      ok: false,
      code: 'tool_error',
      message: 'The tool could not finish.',
    });
    answer = async () => ({ ok: false, code: 'denied', message: `Blocked by ${PATHY}` });
    expect(await call()).toEqual({
      ok: false,
      code: 'denied',
      message: 'That tool is not allowed for this agent right now.',
    });
  });

  it('refuses an answer too large to send, rather than cut it', async () => {
    answer = async () => ({ ok: true, output: 'x'.repeat(600 * 1024) });
    expect(await call()).toMatchObject({ ok: false, code: 'output_too_large' });
  });
});

describe('tools.list', () => {
  const summary = (name: string): RelayToolSummary => ({
    name,
    description: name,
    inputSchema: { type: 'object' },
  });

  beforeEach(() => {
    deps.runner.list = async () => Object.keys(ACTIONS).map(summary);
  });

  const list = (agentId = SCOUT, sessionId = SESSION) =>
    handleBridgedToolList({ computerId: COMPUTER, agentId, sessionId }, deps);

  it('leaves out setup tools and the computer`s own tools', async () => {
    const listed = await list();
    expect(listed.ok && listed.tools.map((tool) => tool.name)).toEqual([
      'post_to_room',
      'read_room_history',
      'tasks_create',
      'request_permission',
    ]);
  });

  it('shows DorkBot the setup tools only with the grant', async () => {
    const without = await list(DORKBOT, DORKBOT_SESSION);
    expect(without.ok && without.tools.map((tool) => tool.name)).not.toContain(
      'marketplace_install'
    );
    granted = true;
    const withGrant = await list(DORKBOT, DORKBOT_SESSION);
    expect(withGrant.ok && withGrant.tools.map((tool) => tool.name)).toContain(
      'marketplace_install'
    );
  });

  it('shows a teammate-tier turn only what the teammate table allows', async () => {
    turns[SESSION] = { ...ownerTurn(SCOUT), tier: 'teammate', roomId: 'r1' };
    const listed = await list();
    expect(listed.ok && listed.tools.map((tool) => tool.name)).toEqual([
      'post_to_room',
      'read_room_history',
    ]);
  });

  it('refuses a session the hub did not start', async () => {
    expect(await list(SCOUT, DORKBOT_SESSION)).toMatchObject({
      ok: false,
      code: 'unknown_session',
    });
  });
});
