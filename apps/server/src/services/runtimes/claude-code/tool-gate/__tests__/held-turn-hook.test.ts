/**
 * A held turn asks about what the folder's allow rules would have run (DOR-3204). The hook only
 * answers `ask`; that Claude Code then sends the call to `canUseTool` while a deny rule still
 * refuses it was checked live against the CLI this SDK ships (PR notes), since no unit test can.
 */
import { describe, expect, it } from 'vitest';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import type { TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import type { PermissionModeId } from '@dorkos/shared/schemas';
import {
  createHeldTurnHook,
  FOLDER_RULE_ASK_REASON,
  HELD_TURN_ASK_REASON,
} from '../held-turn-hook.js';

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
const FOLDERS = { cwd: '/agents/ana', roots: ['/agents/ana', '/rooms/r1'] };

async function decide(
  session: {
    permissionMode: PermissionModeId;
    turnPermissionCeiling?: TurnPermissionCeiling;
    backgroundPermissionCeiling?: TurnPermissionCeiling;
  },
  input: HookInput,
  identity: unknown = { identity: { agentPath: '/a' } }
) {
  const hook = createHeldTurnHook(session, async () => identity, noopLog, FOLDERS);
  return hook(input, 'tool-1', signal);
}

describe('the held turn hook', () => {
  it('asks about a command the folder allows, on a held turn', async () => {
    const python = call('Bash', { command: 'python3 -c 1' });
    expect(await decide({ permissionMode: 'default', ...HELD }, python)).toEqual(ASK);
    // A chat set to Full never asks (DOR-3394): a stranger's hold does not lower it for asking.
    expect(await decide({ permissionMode: 'bypassPermissions', ...HELD }, python)).toEqual({});
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

  it('lets through what DorkOS runs unasked and the CLI’s own bookkeeping', async () => {
    const dorkos = { name: 'dorkos', source: 'sdk' };
    const queued = call('mcp__dorkos__chat_send', { to: 'c', message: 'hi' }, dorkos);
    expect(await decide({ permissionMode: 'default', ...HELD }, queued)).toEqual({});
    for (const tool of ['TodoWrite', 'Task', 'AskUserQuestion', 'Skill']) {
      expect(await decide({ permissionMode: 'default', ...HELD }, call(tool))).toEqual({});
    }
  });

  it('asks about an owner-facing DorkOS verb from a session that names nobody', async () => {
    const dorkos = { name: 'dorkos', source: 'sdk' };
    const post = call('mcp__dorkos__post_to_room', { roomId: 'r', text: 'hi' }, dorkos);
    expect(await decide({ permissionMode: 'default', ...HELD }, post)).toEqual({});
    expect(await decide({ permissionMode: 'default', ...HELD }, post, {})).toEqual(ASK);
  });

  it('lets a held turn read inside its folders, and asks about a read outside them', async () => {
    const held = { permissionMode: 'default' as const, ...HELD };
    const inside: [string, Record<string, unknown>][] = [
      ['Read', { file_path: '/agents/ana/notes.md' }],
      ['Read', { file_path: '/rooms/r1/plan.md' }],
      ['Grep', { pattern: 'x' }],
      ['Grep', { pattern: 'x', path: 'src' }],
      ['Glob', { pattern: '**/*.ts' }],
      ['LS', { path: '/agents/ana' }],
    ];
    for (const [tool, input] of inside) {
      expect(await decide(held, call(tool, input)), `${tool} ${JSON.stringify(input)}`).toEqual({});
    }
    const outside: [string, Record<string, unknown>][] = [
      ['Read', { file_path: '/Users/me/.ssh/id_rsa' }],
      ['Read', { file_path: '/agents/ana/../bob/secret' }],
      ['Grep', { pattern: 'x', path: '/etc' }],
      ['Glob', { pattern: '/Users/**/*.pem' }],
      ['Glob', { pattern: '../**' }],
      ['LS', { path: '/' }],
    ];
    for (const [tool, input] of outside) {
      expect(await decide(held, call(tool, input)), `${tool} ${JSON.stringify(input)}`).toEqual(
        ASK
      );
    }
  });

  it('lets a plain read-only command through, and asks about every other', async () => {
    const held = { permissionMode: 'default' as const, ...HELD };
    for (const command of [
      'ls',
      'ls -la src',
      'pwd',
      'cat README.md',
      'grep -rn "todo" src',
      'git status',
      'git log --oneline -5',
      'git diff',
      'find . -name "*.ts"',
      'wc -l *.md',
    ]) {
      expect(await decide(held, call('Bash', { command })), command).toEqual({});
    }
    for (const command of [
      'python3 -c 1',
      'cat /etc/passwd',
      'ls ~',
      'cat ../other/secret',
      'ls .*',
      'ls; rm -rf x',
      'cat a | sh',
      'cat $(echo x)',
      'cat a > b',
      'git branch new',
      'git -c core.pager=sh status',
      'git diff --output=x',
      'find . -delete',
      'find . -exec rm {} +',
      'FOO=1 ls',
      "grep 'a' '/etc/hosts'",
    ]) {
      expect(await decide(held, call('Bash', { command })), command).toEqual(ASK);
    }
  });

  it('asks about the web and every edit on a held turn', async () => {
    for (const tool of ['WebFetch', 'Edit', 'Write', 'NotebookEdit', 'Monitor']) {
      expect(await decide({ permissionMode: 'default', ...HELD }, call(tool))).toEqual(ASK);
    }
  });
});

describe('a folder rule nobody approved, below Full (DOR-5237)', () => {
  const FOLDER_ASK = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: FOLDER_RULE_ASK_REASON,
    },
  };
  /** A check that answers `mustAsk` for every call, recording what it was asked. */
  function folderCheck(answer: boolean) {
    const asked: string[] = [];
    return {
      asked,
      check: {
        mustAsk: async (toolName: string) => {
          asked.push(toolName);
          return answer;
        },
      },
    };
  }
  async function decideWith(
    session: { permissionMode: PermissionModeId; turnPermissionCeiling?: TurnPermissionCeiling },
    input: HookInput,
    answer: boolean
  ) {
    const { check } = folderCheck(answer);
    const hook = createHeldTurnHook(
      session,
      async () => ({ identity: { agentPath: '/a' } }),
      noopLog,
      FOLDERS,
      check
    );
    return hook(input, 'tool-1', signal);
  }
  const python = call('Bash', { command: 'python3 -c 1' });

  it('asks when only an unapproved folder rule would run the call, in every mode below Full', async () => {
    for (const mode of ['default', 'acceptEdits', 'dontAsk', 'plan', 'auto'] as const) {
      expect(await decideWith({ permissionMode: mode }, python, true), mode).toEqual(FOLDER_ASK);
    }
  });

  it('answers nothing when the check finds nothing, or the chat is set to Full', async () => {
    expect(await decideWith({ permissionMode: 'default' }, python, false)).toEqual({});
    expect(await decideWith({ permissionMode: 'bypassPermissions' }, python, true)).toEqual({});
  });

  it('lets through what it lets through on a held turn', async () => {
    const reads = [
      call('Read', { file_path: '/agents/ana/notes.md' }),
      call('Bash', { command: 'ls -la src' }),
      call('TodoWrite'),
      call('mcp__dorkos__chat_send', { to: 'c', message: 'hi' }, { name: 'dorkos', source: 'sdk' }),
    ];
    for (const input of reads) {
      expect(await decideWith({ permissionMode: 'default' }, input, true)).toEqual({});
    }
  });

  it('keeps a held turn’s own answer, and never asks the folder check there', async () => {
    const { asked, check } = folderCheck(false);
    const hook = createHeldTurnHook(
      { permissionMode: 'default', ...HELD },
      async () => ({}),
      noopLog,
      FOLDERS,
      check
    );
    expect(await hook(python, 'tool-1', signal)).toEqual(ASK);
    expect(asked).toEqual([]);
  });

  it('lets Accept edits run an edit inside the working folder, and asks about one outside', async () => {
    const inside = call('Write', { file_path: '/agents/ana/notes.md', content: 'x' });
    const outside = call('Write', { file_path: '/etc/hosts', content: 'x' });
    const relative = call('Edit', { file_path: 'notes.md', old_string: 'a', new_string: 'b' });
    expect(await decideWith({ permissionMode: 'acceptEdits' }, inside, true)).toEqual({});
    expect(await decideWith({ permissionMode: 'acceptEdits' }, relative, true)).toEqual({});
    expect(await decideWith({ permissionMode: 'acceptEdits' }, outside, true)).toEqual(FOLDER_ASK);
    expect(await decideWith({ permissionMode: 'default' }, inside, true)).toEqual(FOLDER_ASK);
  });
});
