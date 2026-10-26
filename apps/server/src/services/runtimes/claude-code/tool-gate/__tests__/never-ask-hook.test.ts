/**
 * At Never ask, DorkOS's own safe tools run again, through a `PreToolUse`
 * hook that makes the gate's own per-call decision (DOR-3042, after #3072).
 * Under `dontAsk` the CLI calls no `canUseTool`, and that a hook's `allow`
 * runs a call there while a deny rule still beats it was proven on the real
 * CLI by QA (`hook-probe-2026-10-25`); these pin the decision itself, and that
 * on any doubt the hook says nothing, so the call stays refused.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import type { TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import type { PermissionModeId } from '@dorkos/shared/schemas';
import { createNeverAskHook, NEVER_ASK_HOOK_TIMEOUT_MS } from '../never-ask-hook.js';
import { dorkosAutoAllows } from '../auto-allow.js';

const SDK = { name: 'dorkos', source: 'sdk' };

/** A `PreToolUse` input for one call, as Claude Code hands it. */
function call(
  toolName: string,
  toolInput: Record<string, unknown> = {},
  mcpServer: { name: string; source: string } | null = SDK
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

const ALLOW = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    permissionDecisionReason: 'DorkOS runs its own safe tools without asking.',
  },
};
const NEVER_ASK = { permissionMode: 'dontAsk' as PermissionModeId };
const STRANGER = { turnPermissionCeiling: 'runtime-default' as const };
const noopLog = { debug: () => {}, info: () => {} };
const signal = { signal: new AbortController().signal };
const IDENTITY = { identity: { agentPath: '/agents/ana' } };

async function decide(
  session: {
    permissionMode: PermissionModeId;
    turnPermissionCeiling?: TurnPermissionCeiling;
    backgroundPermissionCeiling?: TurnPermissionCeiling;
    teammateTier?: { roomId: string | null };
  },
  input: HookInput,
  resolveIdentity: () => Promise<unknown> = async () => IDENTITY
) {
  return createNeverAskHook(session, resolveIdentity, noopLog)(input, 'tool-1', signal);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the Never ask hook', () => {
  it('lets one of DorkOS’s own safe tools run', async () => {
    expect(await decide(NEVER_ASK, call('mcp__dorkos__post_to_room', { roomId: 'r' }))).toEqual(
      ALLOW
    );
    expect(await decide(NEVER_ASK, call('mcp__dorkos__read_room_history'))).toEqual(ALLOW);
  });

  it('says nothing in every other mode, so the gate decides as before', async () => {
    for (const permissionMode of ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto']) {
      const session = { permissionMode: permissionMode as PermissionModeId };
      expect(await decide(session, call('mcp__dorkos__post_to_room'))).toEqual({});
    }
  });

  it('says nothing for a name it does not know, exactly, or a built-in tool', async () => {
    for (const name of [
      'mcp__dorkos__not_a_tool',
      'mcp__dorkos__post_to_room_x',
      'mcp__dorkos__config_patch',
      'Bash',
      'Edit',
      'Write',
      'WebFetch',
      'Read',
    ]) {
      expect(await decide(NEVER_ASK, call(name))).toEqual({});
    }
  });

  it('says nothing for a server that only calls itself dorkos, or one with no source', async () => {
    const project = { name: 'dorkos', source: 'project' };
    expect(await decide(NEVER_ASK, call('mcp__dorkos__post_to_room', {}, project))).toEqual({});
    expect(await decide(NEVER_ASK, call('mcp__dorkos__post_to_room', {}, null))).toEqual({});
  });

  it('gates control_ui per effect', async () => {
    expect(
      await decide(
        NEVER_ASK,
        call('mcp__dorkos__control_ui', { action: 'open_panel', panel: 'tasks' })
      )
    ).toEqual(ALLOW);
    expect(
      await decide(
        NEVER_ASK,
        call('mcp__dorkos__control_ui', { action: 'apply_layout', shape: 'x' })
      )
    ).toEqual({});
  });

  it('in a turn a stranger’s words reached: no chat_send at all, no chat_stop, no accounts', async () => {
    const session = { ...NEVER_ASK, ...STRANGER };
    for (const [name, input] of [
      ['mcp__dorkos__chat_send', { to: 'c', message: 'hi' }],
      ['mcp__dorkos__chat_send', { to: 'c', message: 'hi', delivery: 'queue' }],
      ['mcp__dorkos__chat_stop', { chat: 'c' }],
      ['mcp__dorkos__accounts_usage', {}],
      ['mcp__dorkos__accounts_probe', { account: 'a' }],
    ] as const) {
      expect(await decide(session, call(name, input))).toEqual({});
    }
    // Background work an earlier such turn left running carries the same mark.
    const background = { ...NEVER_ASK, backgroundPermissionCeiling: 'runtime-default' as const };
    expect(await decide(background, call('mcp__dorkos__chat_send', { to: 'c' }))).toEqual({});
  });

  it('sends no chat_send from a turn held to any ceiling, not only a stranger’s', async () => {
    const session = { ...NEVER_ASK, turnPermissionCeiling: 'default' as TurnPermissionCeiling };
    expect(
      await decide(session, call('mcp__dorkos__chat_send', { to: 'c', message: 'hi' }))
    ).toEqual({});
  });

  it('says nothing on a teammate’s turn, whatever the tool', async () => {
    const session = { ...NEVER_ASK, teammateTier: { roomId: 'r1' } };
    expect(await decide(session, call('mcp__dorkos__read_room_history', { roomId: 'r1' }))).toEqual(
      {}
    );
  });

  it('says nothing when a ceiling holds a Never ask chat to a mode that asks', async () => {
    // The CLI then runs in that mode and calls canUseTool, which decides.
    const session = { ...NEVER_ASK, turnPermissionCeiling: 'plan' as TurnPermissionCeiling };
    expect(await decide(session, call('mcp__dorkos__read_room_history'))).toEqual({});
  });

  it('needs the identity the room verbs need, and fails closed when the lookup throws', async () => {
    expect(await decide(NEVER_ASK, call('mcp__dorkos__post_to_room'), async () => ({}))).toEqual(
      {}
    );
    expect(
      await decide(NEVER_ASK, call('mcp__dorkos__post_to_room'), async () => {
        throw new Error('index unreadable');
      })
    ).toEqual({});
  });

  it('says nothing when the decision takes too long', async () => {
    vi.useFakeTimers();
    const pending = decide(
      NEVER_ASK,
      call('mcp__dorkos__post_to_room'),
      () => new Promise(() => {})
    );
    await vi.advanceTimersByTimeAsync(NEVER_ASK_HOOK_TIMEOUT_MS + 1);
    expect(await pending).toEqual({});
  });

  it('answers nothing for any other hook event', async () => {
    const input = {
      ...call('mcp__dorkos__post_to_room'),
      hook_event_name: 'PostToolUse',
    } as HookInput;
    expect(await decide(NEVER_ASK, input)).toEqual({});
  });
});

describe('the account tools on the safe list (DOR-3289 slice 1)', () => {
  const allows = (session: Parameters<typeof dorkosAutoAllows>[0], name: string) =>
    dorkosAutoAllows(session, name, {}, SDK, async () => IDENTITY, noopLog);

  it('run unasked on an unmarked turn', async () => {
    const session = { permissionMode: 'default' as PermissionModeId };
    expect(await allows(session, 'mcp__dorkos__accounts_usage')).toBe(true);
    expect(await allows(session, 'mcp__dorkos__accounts_probe')).toBe(true);
  });

  it('ask on a turn held to any ceiling: a stranger’s, or a teammate’s level', async () => {
    const held: TurnPermissionCeiling[] = ['runtime-default', 'default' as TurnPermissionCeiling];
    for (const turnPermissionCeiling of held) {
      const session = { permissionMode: 'default' as PermissionModeId, turnPermissionCeiling };
      expect(await allows(session, 'mcp__dorkos__accounts_usage')).toBe(false);
      expect(await allows(session, 'mcp__dorkos__accounts_probe')).toBe(false);
    }
  });
});
