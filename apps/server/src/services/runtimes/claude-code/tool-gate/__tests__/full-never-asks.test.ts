/**
 * A chat set to Full autonomy asks nobody anything (DOR-3394, the product owner's rule). Its
 * level is read from what the chat is set to, so a mark or a hold never puts one of its calls in
 * front of a person: not the held-turn hook, not
 * `canUseTool`. Below Full the asks stay, and a turn nobody is watching is refused at once rather
 * than left waiting on a card.
 *
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import type { TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import { NO_APPROVAL_SURFACE } from '@dorkos/shared/run-refusals';
import type { PermissionModeId } from '@dorkos/shared/schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { createHeldTurnHook, HELD_TURN_ASK_REASON } from '../held-turn-hook.js';
import {
  createCanUseTool,
  type ToolApprovalContext,
} from '../../messaging/interactive-handlers.js';
import type { PendingInteraction } from '../../messaging/interaction-wait.js';
import { chosenFullAutonomy } from '../../turn-permission.js';

const FOLDERS = { cwd: '/agents/ana', roots: ['/agents/ana'] };
const noopLog = { debug: () => {}, info: () => {} };
const DORKOS = { name: 'dorkos', source: 'sdk' };

/** Every bound a mark or a hold can put on a turn. */
const BOUNDS: [string, TurnPermissionCeiling][] = [
  ['a stranger’s hold', 'runtime-default'],
  ['a marked lower level', { asks: 'always', reach: 'edit', outsider: true } as never],
];

/** Calls a held turn below Full is asked about. */
const ASKED: [string, Record<string, unknown>][] = [
  ['Bash', { command: 'gh pr list' }],
  ['Bash', { command: 'git push' }],
  ['Bash', { command: 'pnpm test' }],
  ['Edit', { file_path: '/agents/ana/.git/config', old_string: 'a', new_string: 'b' }],
  ['Edit', { file_path: '/agents/ana/.dork/SOUL.md', old_string: 'a', new_string: 'b' }],
];

/** The DorkOS tools DOR-3394 saw sent to a card in a Full scheduled run. */
const DOR_3394_TOOLS = [
  'end_beat',
  'accounts_usage',
  'session_start',
  'commitments_list',
  'commitment_add',
  'accounts_probe',
].map((name) => `mcp__dorkos__${name}`);

function call(toolName: string, toolInput: Record<string, unknown>, mcp = false): HookInput {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 's',
    transcript_path: '/tmp/t.jsonl',
    cwd: FOLDERS.cwd,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 't',
    ...(mcp ? { mcp_server: DORKOS } : {}),
  } as HookInput;
}

async function hookSays(
  session: { permissionMode: PermissionModeId; turnPermissionCeiling?: TurnPermissionCeiling },
  input: HookInput
) {
  const hook = createHeldTurnHook(
    session,
    async () => ({ identity: { agentPath: FOLDERS.cwd } }),
    noopLog,
    FOLDERS
  );
  return hook(input, 't', { signal: new AbortController().signal });
}

function gateSession(
  permissionMode: PermissionModeId,
  extra: { turnPermissionCeiling?: TurnPermissionCeiling; unattended?: boolean } = {}
) {
  return {
    permissionMode,
    cwd: FOLDERS.cwd,
    pendingInteractions: new Map<string, PendingInteraction>(),
    eventQueue: [] as StreamEvent[],
    eventQueueNotify: vi.fn(),
    ...extra,
  };
}

function context(toolUseID: string, mcp = false): ToolApprovalContext {
  return {
    signal: new AbortController().signal,
    toolUseID,
    ...(mcp ? { mcpServer: DORKOS } : {}),
  };
}

describe('a chat set to Full autonomy never asks', () => {
  it('is read from what the chat is set to, never from a ceiling', () => {
    expect(chosenFullAutonomy({ permissionMode: 'bypassPermissions' })).toBe(true);
    // The agent's level a chat that follows its agent up starts from is what it is set to.
    expect(
      chosenFullAutonomy({ permissionMode: 'default', turnLevelMode: 'bypassPermissions' })
    ).toBe(true);
    expect(
      chosenFullAutonomy({ permissionMode: 'bypassPermissions', turnLevelMode: 'default' })
    ).toBe(false);
    for (const mode of ['default', 'acceptEdits', 'auto', 'plan', 'dontAsk']) {
      expect(chosenFullAutonomy({ permissionMode: mode }), mode).toBe(false);
    }
  });

  for (const [label, turnPermissionCeiling] of BOUNDS) {
    it(`the held-turn hook answers nothing under ${label}`, async () => {
      const session = { permissionMode: 'bypassPermissions' as const, turnPermissionCeiling };
      for (const [tool, input] of ASKED) {
        const said = await hookSays(session, call(tool, input));
        expect(said, `${tool} ${JSON.stringify(input)}`).toEqual({});
      }
      for (const tool of DOR_3394_TOOLS) {
        expect(await hookSays(session, call(tool, {}, true)), tool).toEqual({});
      }
    });

    it(`canUseTool allows without a card under ${label}, even with nobody watching`, async () => {
      const session = gateSession('bypassPermissions', { turnPermissionCeiling, unattended: true });
      const canUseTool = createCanUseTool(session, noopLog, undefined, async () => ({
        identity: { agentPath: FOLDERS.cwd },
      }));
      for (const [index, [tool, input]] of ASKED.entries()) {
        expect(await canUseTool(tool, input, context(`a-${index}`))).toEqual({
          behavior: 'allow',
          updatedInput: input,
        });
      }
      for (const tool of DOR_3394_TOOLS) {
        expect(await canUseTool(tool, {}, context(tool, true)), tool).toEqual({
          behavior: 'allow',
          updatedInput: {},
        });
      }
      // No card, and no refusal for want of one.
      expect(session.eventQueue).toEqual([]);
      expect(session.pendingInteractions.size).toBe(0);
    });
  }
});

describe('below Full the asks stay', () => {
  it('a held turn asks about the DOR-3394 tools', async () => {
    const session = {
      permissionMode: 'default' as const,
      turnPermissionCeiling: 'runtime-default' as const,
    };
    for (const tool of ['end_beat', 'accounts_usage'].map((n) => `mcp__dorkos__${n}`)) {
      expect(await hookSays(session, call(tool, {}, true)), tool).toMatchObject({
        hookSpecificOutput: {
          permissionDecision: 'ask',
          permissionDecisionReason: HELD_TURN_ASK_REASON,
        },
      });
    }
  });

  it('an attended turn raises the card', async () => {
    const session = gateSession('acceptEdits', { turnPermissionCeiling: 'runtime-default' });
    void createCanUseTool(session, noopLog)('Bash', { command: 'git push' }, context('card'));
    await vi.waitFor(() => expect(session.pendingInteractions.has('card')).toBe(true));
    expect(session.eventQueue[0]?.type).toBe('approval_required');
  });

  it('a chat stored at Full whose agent is set to Ask is below Full: it asks, or fails fast (DOR-3175)', async () => {
    // The agent's level rides in the turn's ceiling as a plain level, beside the hold.
    const AGENT_AT_ASK = { asks: 'always', reach: 'edit' } as const;
    const turnPermissionCeiling = [
      'runtime-default',
      AGENT_AT_ASK,
    ] as unknown as TurnPermissionCeiling;
    expect(chosenFullAutonomy({ permissionMode: 'bypassPermissions', turnPermissionCeiling })).toBe(
      false
    );
    const said = await hookSays(
      { permissionMode: 'bypassPermissions', turnPermissionCeiling },
      call('Bash', { command: 'git push' })
    );
    expect(said).toMatchObject({
      hookSpecificOutput: { permissionDecisionReason: HELD_TURN_ASK_REASON },
    });
    const session = gateSession('bypassPermissions', { turnPermissionCeiling, unattended: true });
    expect(
      await createCanUseTool(session, noopLog)('Bash', { command: 'git push' }, context('ask'))
    ).toMatchObject({ behavior: 'deny' });
    expect(session.pendingInteractions.size).toBe(0);
    expect(session.eventQueue[0]?.data).toMatchObject({ reasonType: NO_APPROVAL_SURFACE });
  });

  it('an unattended turn is refused at once with a reason, and no card is raised', async () => {
    const session = gateSession('acceptEdits', {
      turnPermissionCeiling: 'runtime-default',
      unattended: true,
    });
    const result = await createCanUseTool(session, noopLog)(
      'Bash',
      { command: 'git push' },
      context('nobody')
    );
    expect(result).toMatchObject({ behavior: 'deny' });
    expect(session.pendingInteractions.size).toBe(0);
    expect(session.eventQueue.map((event) => event.type)).toEqual(['permission_denied']);
    expect(session.eventQueue[0]?.data).toMatchObject({ reasonType: NO_APPROVAL_SURFACE });
  });
});
