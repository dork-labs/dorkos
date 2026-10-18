/**
 * The teammate fence in Claude Code (DOR-2955): the per-turn field a teammate's turn sets, and the
 * `PreToolUse` hook that refuses what that turn may not use, before any allow rule is read.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { askCallHash, setAskOwnerPort } from '../../../core/turn-power/ask-owner.js';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { TEAMMATE_TIER_DENIAL } from '../../../core/turn-power/teammate-tier.js';
import type { AgentSession } from '../agent-types.js';
import { createTeammateTierHook } from '../teammate-tier-hook.js';
import { assignTurnBounds } from '../turn-bounds.js';

type Bounds = Pick<
  AgentSession,
  'unattendedApprovals' | 'unattendedTurn' | 'turnPermissionCeiling' | 'teammateTier'
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
  return createTeammateTierHook(session)(input, 'tool-1', signal);
}

const DENY = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: TEAMMATE_TIER_DENIAL,
  },
};

describe('assignTurnBounds', () => {
  it('fences a teammate’s turn to the room it answers, with nobody to ask', () => {
    const session: Bounds = {};
    assignTurnBounds(session, {
      unattended: true,
      roomTurn: { roomId: 'room-a', authorId: 'ana', turnId: 't1', teammate: true },
    });
    expect(session.teammateTier).toEqual({ roomId: 'room-a', sharedFolder: null, authorId: 'ana' });
    expect(session.unattendedTurn).toBe(true);
  });

  it('carries who asked and the one allowed call, for this send only (DOR-2956)', () => {
    const session: Bounds = {};
    const pass = { approvalId: 'appr-1', tool: 'Bash', inputHash: 'h' };
    const asker = { memberId: 'member-bo', displayName: 'Bo' };
    const opts = {
      unattended: true,
      roomTurn: {
        roomId: 'room-a',
        authorId: 'ana',
        turnId: 't1',
        teammate: true as const,
        teammateAsker: asker,
        teammatePass: pass,
      },
    };
    assignTurnBounds(session, opts);
    expect(session.teammateTier).toMatchObject({ asker, pass });
    // A copy: spending it on the session never changes the options it came from.
    delete session.teammateTier!.pass;
    expect(opts.roomTurn.teammatePass).toEqual(pass);
    assignTurnBounds(session, { roomTurn: { roomId: 'room-a', authorId: 'ana', turnId: 't2' } });
    expect(session.teammateTier).toBeUndefined();
  });

  it('gives an owner’s turn no pass, whatever its options carry', () => {
    const session: Bounds = {};
    assignTurnBounds(session, {
      roomTurn: {
        roomId: 'room-a',
        authorId: 'ana',
        turnId: 't1',
        teammatePass: { approvalId: 'appr-1', tool: 'Bash', inputHash: 'h' },
      },
    });
    expect(session.teammateTier).toBeUndefined();
  });

  it('clears the fence on the next turn that is not a teammate’s', () => {
    const session: Bounds = {
      teammateTier: { roomId: 'room-a', sharedFolder: null },
      unattendedTurn: true,
    };
    assignTurnBounds(session, { roomTurn: { roomId: 'room-a', authorId: 'ana', turnId: 't2' } });
    expect(session.teammateTier).toBeUndefined();
    expect(session.unattendedTurn).toBe(false);
    assignTurnBounds(session, undefined);
    expect(session.teammateTier).toBeUndefined();
  });
});

describe('the teammate fence hook', () => {
  it('answers nothing while no teammate’s turn is running', async () => {
    expect(await decide({}, call('Bash', { command: 'cat ~/.ssh/id_rsa' }))).toEqual({});
  });

  it('refuses another room, and lets the answered room through', async () => {
    const session: Bounds = { teammateTier: { roomId: 'room-a', sharedFolder: null } };
    expect(
      await decide(session, call('mcp__dorkos__read_room_history', { roomId: 'room-owner' }))
    ).toEqual(DENY);
    expect(
      await decide(session, call('mcp__dorkos__read_room_history', { roomId: 'room-a' }))
    ).toEqual({});
  });

  it('refuses the cross-room reads and the shell outright', async () => {
    const session: Bounds = { teammateTier: { roomId: 'room-a', sharedFolder: null } };
    for (const tool of ['mcp__dorkos__search_member_rooms', 'mcp__dorkos__chat_read', 'Bash']) {
      expect(await decide(session, call(tool, { roomId: 'room-a' }))).toEqual(DENY);
    }
    const read = (await decide(session, call('Read', { file_path: '/anywhere/notes.md' }))) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(read.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(read.hookSpecificOutput.permissionDecisionReason).toContain(
      'this space shares no folder'
    );
    expect(await decide(session, call('TodoWrite', { todos: [] }))).toEqual({});
  });

  it('treats a configured server calling itself dorkos as another server, and refuses it', async () => {
    const session: Bounds = { teammateTier: { roomId: 'room-a', sharedFolder: null } };
    expect(
      await decide(
        session,
        call('mcp__dorkos__read_room_history', { roomId: 'room-a' }, { source: 'project' })
      )
    ).toEqual(DENY);
  });

  it('reads the fence when the call is made, not when the hook was built', async () => {
    const session: Bounds = {};
    const hook = createTeammateTierHook(session);
    session.teammateTier = { roomId: 'room-a', sharedFolder: null };
    expect(await hook(call('Bash'), 'tool-1', signal)).toEqual(DENY);
    delete session.teammateTier;
    expect(await hook(call('Bash'), 'tool-1', signal)).toEqual({});
  });

  it('allows a Read of a shared file past the runtime’s own rules, by its resolved path', async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), 'hook-read-')));
    try {
      await mkdir(path.join(base, 'acme'));
      await writeFile(path.join(base, 'acme', 'plan.md'), 'plan');
      const session: Bounds = {
        teammateTier: { roomId: 'room-a', sharedFolder: path.join(base, 'acme') },
      };
      expect(
        await decide(session, call('Read', { file_path: `${base}/acme/./plan.md`, limit: 10 }))
      ).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: 'A file in the space’s shared folder.',
          updatedInput: { file_path: path.join(base, 'acme', 'plan.md'), limit: 10 },
        },
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('the one call the owner allowed (DOR-2956)', () => {
  afterEach(() => setAskOwnerPort(undefined));

  it('allows exactly that call, once, with the approved input, and then refuses it', async () => {
    setAskOwnerPort({ request: vi.fn(), spend: vi.fn().mockReturnValueOnce(true) });
    const input = { command: 'git log -1' };
    const session: Bounds = {
      teammateTier: {
        roomId: 'room-a',
        sharedFolder: null,
        authorId: 'ana',
        asker: { memberId: 'member-bo', displayName: 'Bo' },
        pass: { approvalId: 'appr-1', tool: 'Bash', inputHash: askCallHash('Bash', input) },
      },
    };
    const first = (await decide(session, call('Bash', { ...input, description: 'x' }))) as {
      hookSpecificOutput: { permissionDecision: string; updatedInput: unknown };
    };
    expect(first.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(first.hookSpecificOutput.updatedInput).toEqual(input);
    expect(await decide(session, call('Bash', input))).toEqual(DENY);
  });
});
