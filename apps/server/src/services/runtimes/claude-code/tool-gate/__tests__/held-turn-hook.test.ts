/**
 * A held turn asks about what the folder's allow rules would have run (DOR-3204). The hook only
 * answers `ask`; that Claude Code then sends the call to `canUseTool` while a deny rule still
 * refuses it was checked live against the CLI this SDK ships (PR notes), since no unit test can.
 */
import { describe, expect, it } from 'vitest';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import type { TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import type { PermissionModeId } from '@dorkos/shared/schemas';
import { createHeldTurnHook, HELD_TURN_ASK_REASON } from '../held-turn-hook.js';

/** A `PreToolUse` input for one call, as Claude Code hands it. */
function call(
  toolName: string,
  toolInput: Record<string, unknown> = {},
  mcpServer?: { name: string; source: string }
): HookInput {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'sdk-session',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/agents/ana',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'tool-1',
    ...(mcpServer ? { mcp_server: mcpServer } : {}),
  } as HookInput;
}

const ASK = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'ask',
    permissionDecisionReason: HELD_TURN_ASK_REASON,
  },
};
const HELD = { turnPermissionCeiling: 'runtime-default' as const };
const FULL_LEVEL = { asks: 'never', reach: 'everything' } as unknown as TurnPermissionCeiling;
const noopLog = { debug: () => {}, info: () => {} };
const signal = { signal: new AbortController().signal };

async function decide(
  session: {
    permissionMode: PermissionModeId;
    turnPermissionCeiling?: TurnPermissionCeiling;
    backgroundPermissionCeiling?: TurnPermissionCeiling;
  },
  input: HookInput
) {
  const hook = createHeldTurnHook(
    session,
    async () => ({ identity: { agentPath: '/a' } }),
    noopLog
  );
  return hook(input, 'tool-1', signal);
}

describe('the held turn hook', () => {
  it('asks about a command the folder allows, on a held turn', async () => {
    const python = call('Bash', { command: 'python3 -c 1' });
    expect(await decide({ permissionMode: 'default', ...HELD }, python)).toEqual(ASK);
    // A chat set to Full, held by a stranger's message, runs at Default and asks too.
    expect(await decide({ permissionMode: 'bypassPermissions', ...HELD }, python)).toEqual(ASK);
    expect(
      await decide(
        { permissionMode: 'default', backgroundPermissionCeiling: 'runtime-default' },
        python
      )
    ).toEqual(ASK);
  });

  it('leaves a turn that is not held to the folder’s rules', async () => {
    const python = call('Bash', { command: 'python3 -c 1' });
    expect(await decide({ permissionMode: 'default' }, python)).toEqual({});
    expect(await decide({ permissionMode: 'bypassPermissions' }, python)).toEqual({});
    // Another of the owner's agents holding the turn to its own level is not a stranger.
    expect(
      await decide(
        { permissionMode: 'bypassPermissions', turnPermissionCeiling: FULL_LEVEL },
        python
      )
    ).toEqual({});
    // Even where that agent's level leaves the chat at Default: the folder's rules are the owner's.
    const DEFAULT_LEVEL = { asks: 'always', reach: 'edit' } as unknown as TurnPermissionCeiling;
    expect(
      await decide({ permissionMode: 'default', turnPermissionCeiling: DEFAULT_LEVEL }, python)
    ).toEqual({});
  });

  it('asks about a locally allowed MCP tool DorkOS would ask about itself', async () => {
    const dorkos = { name: 'dorkos', source: 'sdk' };
    const steer = call(
      'mcp__dorkos__chat_send',
      { to: 'c', message: 'hi', delivery: 'steer' },
      dorkos
    );
    expect(await decide({ permissionMode: 'default', ...HELD }, steer)).toEqual(ASK);
    const patch = call('mcp__dorkos__config_patch', {}, dorkos);
    expect(await decide({ permissionMode: 'default', ...HELD }, patch)).toEqual(ASK);
    const foreign = call('mcp__github__create_issue', {}, { name: 'github', source: 'project' });
    expect(await decide({ permissionMode: 'default', ...HELD }, foreign)).toEqual(ASK);
  });

  it('lets through what DorkOS runs unasked, the file reads and the CLI’s own bookkeeping', async () => {
    const dorkos = { name: 'dorkos', source: 'sdk' };
    const queued = call('mcp__dorkos__chat_send', { to: 'c', message: 'hi' }, dorkos);
    expect(await decide({ permissionMode: 'default', ...HELD }, queued)).toEqual({});
    for (const tool of ['Read', 'Grep', 'Glob', 'TodoWrite', 'Task', 'AskUserQuestion']) {
      expect(await decide({ permissionMode: 'default', ...HELD }, call(tool))).toEqual({});
    }
  });

  it('asks about the web and every edit on a held turn', async () => {
    for (const tool of ['WebFetch', 'Edit', 'Write', 'NotebookEdit', 'Monitor']) {
      expect(await decide({ permissionMode: 'default', ...HELD }, call(tool))).toEqual(ASK);
    }
  });
});
