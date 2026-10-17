/**
 * The teammate fence in Claude Code (DOR-2955): the per-turn field a teammate's turn sets, and the
 * `PreToolUse` hook that refuses what that turn may not use, before any allow rule is read.
 */
import { describe, expect, it } from 'vitest';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { TEAMMATE_FENCE_DENIAL } from '../../../core/turn-power/teammate-fence.js';
import type { AgentSession } from '../agent-types.js';
import { createTeammateFenceHook } from '../teammate-fence-hook.js';
import { assignTurnBounds } from '../turn-bounds.js';

type Bounds = Pick<
  AgentSession,
  'unattendedApprovals' | 'unattendedTurn' | 'turnPermissionCeiling' | 'teammateFence'
>;

/** A `PreToolUse` input for one call, as Claude Code hands it. */
function call(
  toolName: string,
  toolInput: Record<string, unknown> = {},
  mcpServer?: { source: string }
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

const signal = { signal: new AbortController().signal };

async function decide(session: Bounds, input: HookInput) {
  return createTeammateFenceHook(session)(input, 'tool-1', signal);
}

const DENY = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: TEAMMATE_FENCE_DENIAL,
  },
};

describe('assignTurnBounds', () => {
  it('fences a teammate’s turn to the room it answers, with nobody to ask', () => {
    const session: Bounds = {};
    assignTurnBounds(session, {
      unattended: true,
      roomTurn: { roomId: 'room-a', authorId: 'ana', turnId: 't1', teammate: true },
    });
    expect(session.teammateFence).toEqual({ roomId: 'room-a' });
    expect(session.unattendedTurn).toBe(true);
  });

  it('clears the fence on the next turn that is not a teammate’s', () => {
    const session: Bounds = { teammateFence: { roomId: 'room-a' }, unattendedTurn: true };
    assignTurnBounds(session, { roomTurn: { roomId: 'room-a', authorId: 'ana', turnId: 't2' } });
    expect(session.teammateFence).toBeUndefined();
    expect(session.unattendedTurn).toBe(false);
    assignTurnBounds(session, undefined);
    expect(session.teammateFence).toBeUndefined();
  });
});

describe('the teammate fence hook', () => {
  it('answers nothing while no teammate’s turn is running', async () => {
    expect(await decide({}, call('Bash', { command: 'cat ~/.ssh/id_rsa' }))).toEqual({});
  });

  it('refuses another room, and lets the answered room through', async () => {
    const session: Bounds = { teammateFence: { roomId: 'room-a' } };
    expect(
      await decide(session, call('mcp__dorkos__read_room_history', { roomId: 'room-owner' }))
    ).toEqual(DENY);
    expect(
      await decide(session, call('mcp__dorkos__read_room_history', { roomId: 'room-a' }))
    ).toEqual({});
  });

  it('refuses the cross-room reads and the shell outright', async () => {
    const session: Bounds = { teammateFence: { roomId: 'room-a' } };
    for (const tool of ['mcp__dorkos__search_member_rooms', 'mcp__dorkos__chat_read', 'Bash']) {
      expect(await decide(session, call(tool, { roomId: 'room-a' }))).toEqual(DENY);
    }
    expect(await decide(session, call('Read', { file_path: 'notes.md' }))).toEqual(DENY);
    expect(await decide(session, call('TodoWrite', { todos: [] }))).toEqual({});
  });

  it('treats a configured server calling itself dorkos as another server, and refuses it', async () => {
    const session: Bounds = { teammateFence: { roomId: 'room-a' } };
    expect(
      await decide(
        session,
        call('mcp__dorkos__read_room_history', { roomId: 'room-a' }, { source: 'project' })
      )
    ).toEqual(DENY);
  });

  it('reads the fence when the call is made, not when the hook was built', async () => {
    const session: Bounds = {};
    const hook = createTeammateFenceHook(session);
    session.teammateFence = { roomId: 'room-a' };
    expect(await hook(call('Bash'), 'tool-1', signal)).toEqual(DENY);
    delete session.teammateFence;
    expect(await hook(call('Bash'), 'tool-1', signal)).toEqual({});
  });
});
