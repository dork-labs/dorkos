/**
 * The hub's side of the tool bridge (DOR-2939 part 6): every rule a bridged
 * call meets before it runs, each with a case that fails if the rule goes.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import {
  clearTestHomes,
  registerTestHomes,
} from '../../agent-identity/__tests__/agent-home-fixture.js';
import { createBridgedToolRateLimits } from '../bridge-guards.js';
import {
  handleBridgedToolCall,
  handleBridgedToolList,
  type BridgedAgent,
  type BridgedToolDeps,
  type BridgedToolRun,
  type BridgedTurn,
} from '../bridged-tool-call.js';
import {
  DORKBOT_NEEDS_OWN_COMPUTER,
  HUB_SETUP_REFUSAL,
  type BridgeAction,
} from '../hub-setup-tools.js';

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

// Real agent folders, registered as homes, so the outsider count is kept per
// agent: an unplaced folder is counted for every agent, which no test could
// tell from a working cap.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bridged-tool-call-'));
const SCOUT_HOME = path.join(ROOT, 'scout');
const DORKBOT_HOME = path.join(ROOT, 'dorkbot');
for (const home of [SCOUT_HOME, DORKBOT_HOME]) fs.mkdirSync(home, { recursive: true });
registerTestHomes([SCOUT_HOME, DORKBOT_HOME]);
afterAll(() => {
  clearTestHomes();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

let AGENTS: Record<string, BridgedAgent>;

const ownerTurn = (agentId: string): BridgedTurn => ({
  agentId,
  tier: 'owner',
  permissionMode: 'default',
  outsiderCapped: false,
  running: true,
});

let place: Record<string, string>;
let mcpOn: boolean;

let turns: Record<string, BridgedTurn>;
let granted: boolean;
let calls: (BridgedToolRun & { tool: string; input: unknown })[];
let answer: () => Promise<RelayToolCallOutcome>;
let deps: BridgedToolDeps;

beforeEach(() => {
  resetLiveOutsiderTurns();
  AGENTS = {
    [SCOUT]: { agentPath: SCOUT_HOME, displayName: 'Scout', isSystem: false, paused: false },
    [DORKBOT]: { agentPath: DORKBOT_HOME, displayName: 'DorkBot', isSystem: true, paused: false },
  };
  place = { [SCOUT]: COMPUTER, [DORKBOT]: COMPUTER };
  mcpOn = true;
  turns = { [SESSION]: ownerTurn(SCOUT), [DORKBOT_SESSION]: ownerTurn(DORKBOT) };
  granted = false;
  calls = [];
  answer = async () => ({ ok: true, output: { done: true } });
  deps = {
    agentWorksOn: (agentId) => place[agentId] ?? null,
    agentsOn: (computerId) => Object.keys(place).filter((id) => place[id] === computerId),
    turnFor: (sessionId) => turns[sessionId] ?? null,
    // As the live one is: read asynchronously from the identity service.
    agent: async (agentId) => AGENTS[agentId] ?? null,
    mcpEnabled: () => mcpOn,
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
      identity: { agentPath: SCOUT_HOME, displayName: 'Scout' },
      sessionId: SESSION,
      computerId: COMPUTER,
      tool: 'post_to_room',
      input: { roomId: 'r1', text: 'hi' },
    });
    expect(calls[0]).not.toHaveProperty('userId');
    expect(calls[0]).not.toHaveProperty('trusted');
    expect(calls[0]!.identity).not.toHaveProperty('inactive');
    expect(calls[0]!.identity).not.toHaveProperty('outsiderCapped');
  });

  it('runs nothing while external MCP is off', async () => {
    mcpOn = false;
    expect(await call()).toMatchObject({ ok: false, code: 'mcp_disabled' });
    expect(calls).toEqual([]);
  });

  it('refuses a paused agent', async () => {
    AGENTS[SCOUT] = { ...AGENTS[SCOUT]!, paused: true };
    expect(await call()).toMatchObject({ ok: false, code: 'agent_paused' });
    expect(calls).toEqual([]);
  });

  it('runs a revoked agent marked so, for the gate to block', async () => {
    AGENTS[SCOUT] = { ...AGENTS[SCOUT]!, inactive: 'revoked' };
    await call();
    expect(calls[0]!.identity.inactive).toBe('revoked');
  });

  it('refuses a session whose turn has ended', async () => {
    turns[SESSION] = { ...ownerTurn(SCOUT), running: false };
    expect(await call()).toMatchObject({ ok: false, code: 'turn_ended' });
    expect(calls).toEqual([]);
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

  it('are refused to DorkBot, grant and all, while another agent shares its computer', async () => {
    granted = true;
    expect(
      await call({ agentId: DORKBOT, sessionId: DORKBOT_SESSION, tool: 'marketplace_install' })
    ).toEqual({ ok: false, code: 'setup_refused', message: DORKBOT_NEEDS_OWN_COMPUTER });
    expect(DORKBOT_NEEDS_OWN_COMPUTER.split(/\s+/).length).toBeLessThanOrEqual(15);
    expect(calls).toEqual([]);
  });

  it.each([
    ['an empty list', () => []],
    ['a list without DorkBot', () => ['01KJXYKJYW4N8QGQ5W4GB6YM9Z']],
  ])(
    'are refused to DorkBot when the hub`s list of who is on its computer is %s',
    async (_label, on) => {
      granted = true;
      deps.agentsOn = on;
      expect(
        await call({ agentId: DORKBOT, sessionId: DORKBOT_SESSION, tool: 'marketplace_install' })
      ).toEqual({ ok: false, code: 'setup_refused', message: DORKBOT_NEEDS_OWN_COMPUTER });
      expect(calls).toEqual([]);
    }
  );

  it('run for DorkBot with the grant, and a destructive one still goes to the gate unapproved', async () => {
    granted = true;
    place[SCOUT] = 'cc-2';
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
    place[SCOUT] = 'cc-2';
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

  it('runs a capped turn marked capped, and counted as reading an outsider`s words', async () => {
    const seen: [boolean, boolean][] = [];
    answer = async () => {
      seen.push([agentIsReadingOutsider(SCOUT_HOME), agentIsReadingOutsider(DORKBOT_HOME)]);
      return { ok: true, output: null };
    };
    await call();
    turns[SESSION] = { ...ownerTurn(SCOUT), outsiderCapped: true };
    await call();
    // Scout is counted during its capped call, and only then; DorkBot never is.
    expect(seen).toEqual([
      [false, false],
      [true, false],
    ]);
    expect(calls.map((run) => run.identity.outsiderCapped)).toEqual([undefined, true]);
    expect(agentIsReadingOutsider(SCOUT_HOME)).toBe(false);
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

  it('never a code outside the fixed list, nor a denial`s own words', async () => {
    answer = async () => ({ ok: false, code: 'ENOENT', message: `Cannot read ${PATHY}` });
    expect(await call()).toMatchObject({ code: 'tool_error' });
    // A denial that came back as an ordinary answer, naming areas and settings.
    answer = async () => ({
      ok: true,
      output: {
        status: 'denied',
        reason: 'permission_blocked',
        message: 'Area packages is Blocked',
      },
    });
    expect(await call()).toEqual({
      ok: false,
      code: 'denied',
      message: 'That tool is not allowed for this agent right now.',
    });
  });

  it('calls an answer too deep to read invalid, not too large', async () => {
    let deep: unknown = 'x';
    for (let i = 0; i < 40; i++) deep = { a: deep };
    answer = async () => ({ ok: true, output: deep as never });
    expect(await call()).toMatchObject({ ok: false, code: 'output_invalid' });
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

  it('shows DorkBot the setup tools only with the grant, and alone on its computer', async () => {
    granted = true;
    const shared = await list(DORKBOT, DORKBOT_SESSION);
    expect(shared.ok && shared.tools.map((tool) => tool.name)).not.toContain('marketplace_install');
    place[SCOUT] = 'cc-2';
    granted = false;
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

  it('reads the grant once per list', async () => {
    const read = vi.fn(() => true);
    deps.dorkbotSetupGranted = read;
    place[SCOUT] = 'cc-2';
    await list(DORKBOT, DORKBOT_SESSION);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('refuses a session the hub did not start', async () => {
    expect(await list(SCOUT, DORKBOT_SESSION)).toMatchObject({
      ok: false,
      code: 'unknown_session',
    });
  });
});
