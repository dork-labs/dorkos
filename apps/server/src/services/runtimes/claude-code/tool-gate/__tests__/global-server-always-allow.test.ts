/**
 * "Always allow" on a server for every agent's tool stays with the agent that
 * was asked (DOR-3213, Security's T9): the CLI keeps the yes in that agent's
 * `localSettings`, never `userSettings` (every Claude session on the machine)
 * or a checked-in `projectSettings`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import type { PermissionMode } from '@dorkos/shared/schemas';
import {
  createCanUseTool,
  type ToolApprovalContext,
} from '../../messaging/interactive-handlers.js';
import type { InteractiveSession, PendingInteraction } from '../../messaging/interaction-wait.js';
import { keepAlwaysAllowToAgent, setGlobalMcpServerLookup } from '../global-server-always-allow.js';

const GLOBAL_TOOL = 'mcp__github__create_issue';

/** The rule the CLI suggests on an MCP tool's card: remember it for every session. */
const USER_RULE: PermissionUpdate = {
  type: 'addRules',
  rules: [{ toolName: GLOBAL_TOOL }],
  behavior: 'allow',
  destination: 'userSettings',
};

function session(cwd: string): InteractiveSession & { permissionMode: PermissionMode } {
  return {
    permissionMode: 'default',
    cwd,
    pendingInteractions: new Map<string, PendingInteraction>(),
    eventQueue: [] as StreamEvent[],
    eventQueueNotify: vi.fn(),
  } as InteractiveSession & { permissionMode: PermissionMode };
}

function context(toolUseID: string, suggestions: PermissionUpdate[]): ToolApprovalContext {
  return {
    signal: new AbortController().signal,
    toolUseID,
    suggestions,
    mcpServer: { name: 'github', source: 'user' },
  };
}

const noopLog = { debug: () => {}, info: () => {} };

/** Press "Always allow" on the card a session raised. */
function answerAlways(s: InteractiveSession, toolUseID: string): void {
  const pending = s.pendingInteractions.get(toolUseID);
  if (pending?.type !== 'approval') throw new Error(`no card for ${toolUseID}`);
  pending.resolve(pending.suggestions ?? []);
}

afterEach(() => setGlobalMcpServerLookup(() => false));

describe('keepAlwaysAllowToAgent', () => {
  it('moves user and project destinations to the agent folder, and keeps session', () => {
    setGlobalMcpServerLookup((name) => name === 'github');
    const narrowed = keepAlwaysAllowToAgent(
      GLOBAL_TOOL,
      context('t', [
        USER_RULE,
        { ...USER_RULE, destination: 'projectSettings' },
        { ...USER_RULE, destination: 'session' },
      ])
    );
    expect(narrowed.suggestions?.map((s) => s.destination)).toEqual([
      'localSettings',
      'localSettings',
      'session',
    ]);
  });

  it('drops a destination this SDK did not have, rather than guessing', () => {
    setGlobalMcpServerLookup(() => true);
    const narrowed = keepAlwaysAllowToAgent(
      GLOBAL_TOOL,
      context('t', [{ ...USER_RULE, destination: 'everywhere' as never }])
    );
    expect(narrowed.suggestions).toEqual([]);
  });

  it("leaves an agent's own server and DorkOS's in-process tools alone", () => {
    setGlobalMcpServerLookup((name) => name === 'github');
    const own = context('t', [USER_RULE]);
    own.mcpServer = { name: 'linear', source: 'user' };
    expect(keepAlwaysAllowToAgent('mcp__linear__list', own)).toBe(own);

    const dorkos = context('t', [USER_RULE]);
    dorkos.mcpServer = { name: 'github', source: 'sdk' };
    expect(keepAlwaysAllowToAgent(GLOBAL_TOOL, dorkos)).toBe(dorkos);
  });

  it('reads the server from the tool name when the SDK does not say', () => {
    setGlobalMcpServerLookup((name) => name === 'github');
    const bare: ToolApprovalContext = {
      signal: new AbortController().signal,
      toolUseID: 't',
      suggestions: [USER_RULE],
    };
    expect(keepAlwaysAllowToAgent(GLOBAL_TOOL, bare).suggestions?.[0]?.destination).toBe(
      'localSettings'
    );
  });
});

describe('startup wiring', () => {
  it('hands the gate the saved servers, so the rule is never off by omission', () => {
    const startup = readFileSync(
      path.resolve(__dirname, '../../../../../startup/steps/mcp-tasks-skills.ts'),
      'utf8'
    );
    expect(startup).toContain('setGlobalMcpServerLookup((name) => globalMcpServers.has(name))');
  });
});

describe('Always allow on a server for every agent, end to end through the gate', () => {
  it('keeps agent A’s yes in A’s folder, and agent B still asks', async () => {
    setGlobalMcpServerLookup((name) => name === 'github');

    const agentA = session('/agents/a');
    const ask = createCanUseTool(agentA, noopLog)(GLOBAL_TOOL, {}, context('a-1', [USER_RULE]));
    const card = agentA.eventQueue[0] as { data: { alwaysAllowScope?: string } };
    // The card names what the click does: this project, not every session.
    expect(card.data.alwaysAllowScope).toBe('project');
    answerAlways(agentA, 'a-1');
    const answer = await ask;
    expect(answer).toMatchObject({ behavior: 'allow' });
    const kept = (answer as { updatedPermissions?: PermissionUpdate[] }).updatedPermissions;
    // `localSettings` is the asking session's own folder (/agents/a), so the
    // rule never reaches ~/.claude/settings.json where agent B would read it.
    expect(kept?.map((s) => s.destination)).toEqual(['localSettings']);

    const agentB = session('/agents/b');
    const second = createCanUseTool(agentB, noopLog)(GLOBAL_TOOL, {}, context('b-1', [USER_RULE]));
    const settled = await Promise.race([
      second.then(() => 'settled' as const),
      Promise.resolve('pending' as const),
    ]);
    expect(settled).toBe('pending');
    expect(agentB.eventQueue[0]?.type).toBe('approval_required');
    agentB.pendingInteractions.get('b-1')?.reject('done');
  });

  it('forwards a non-global server’s suggestion as it was', async () => {
    const agentA = session('/agents/a');
    const own = context('own-1', [USER_RULE]);
    own.mcpServer = { name: 'linear', source: 'user' };
    const ask = createCanUseTool(agentA, noopLog)('mcp__linear__list', {}, own);
    answerAlways(agentA, 'own-1');
    const kept = ((await ask) as { updatedPermissions?: PermissionUpdate[] }).updatedPermissions;
    expect(kept?.map((s) => s.destination)).toEqual(['userSettings']);
  });
});
