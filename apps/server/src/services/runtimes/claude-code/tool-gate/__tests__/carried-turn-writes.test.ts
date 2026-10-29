/**
 * A turn that carries an outsider's words on (DOR-3390) runs at its own level, and its Bash card
 * must not be stepped around: an edit to `.git/config` followed by `git diff` would run any
 * program at Full (Security's M-A), and an edit to the agent's own `.dork` files would launder the
 * words into every later, unmarked turn (M-C). Both now ask; ordinary edits still run.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import type { TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import { CARRIED_OUTSIDER_LEVEL } from '@dorkos/shared/permission-semantics';
import {
  CARRIED_SHELL_ASK_REASON,
  CARRIED_WRITE_ASK_REASON,
  createHeldTurnHook,
} from '../held-turn-hook.js';
import { carriedWriteAsks, runsGit } from '../carried-turn-writes.js';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carried-writes-')));
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

function call(toolName: string, toolInput: Record<string, unknown>): HookInput {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 's',
    transcript_path: '/tmp/t.jsonl',
    cwd: home,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 't',
  } as HookInput;
}

function hookFor(ceiling?: TurnPermissionCeiling) {
  const session = {
    permissionMode: 'bypassPermissions' as const,
    ...(ceiling !== undefined ? { turnPermissionCeiling: ceiling } : {}),
  };
  const hook = createHeldTurnHook(
    session,
    async () => ({ identity: { agentPath: home } }),
    { debug: () => {}, info: () => {} },
    { cwd: home, roots: [home] }
  );
  return async (i: HookInput) => {
    const out = (await hook(i, 't', { signal: new AbortController().signal })) as {
      hookSpecificOutput?: { permissionDecisionReason?: string };
    };
    return out.hookSpecificOutput?.permissionDecisionReason ?? 'runs';
  };
}

const carried = hookFor(CARRIED_OUTSIDER_LEVEL as unknown as TurnPermissionCeiling);
const unmarked = hookFor();

describe('a carried turn: git cannot be turned into a shell (M-A)', () => {
  it('asks before an edit to .git/config, .gitattributes or .gitmodules', async () => {
    const config = path.join(home, '.git', 'config');
    expect(
      await carried(call('Edit', { file_path: config, old_string: 'a', new_string: 'b' }))
    ).toBe(CARRIED_WRITE_ASK_REASON);
    expect(await carried(call('Write', { file_path: config, content: 'x' }))).toBe(
      CARRIED_WRITE_ASK_REASON
    );
    expect(await carried(call('Write', { file_path: '.git/hooks/pre-commit', content: 'x' }))).toBe(
      CARRIED_WRITE_ASK_REASON
    );
    expect(await carried(call('Write', { file_path: 'sub/.gitattributes', content: 'x' }))).toBe(
      CARRIED_WRITE_ASK_REASON
    );
    expect(await carried(call('MultiEdit', { file_path: '.gitmodules', edits: [] }))).toBe(
      CARRIED_WRITE_ASK_REASON
    );
  });

  it('asks before an edit through a link that points into .git', async () => {
    fs.mkdirSync(path.join(home, '.git'), { recursive: true });
    fs.writeFileSync(path.join(home, '.git', 'config'), '');
    fs.symlinkSync(path.join(home, '.git', 'config'), path.join(home, 'innocent.txt'));
    expect(await carried(call('Write', { file_path: 'innocent.txt', content: 'x' }))).toBe(
      CARRIED_WRITE_ASK_REASON
    );
  });

  it('asks before every git command, the plain reads included', async () => {
    for (const command of [
      'git diff',
      'git status',
      'git log',
      "'git' show",
      '/usr/bin/git diff',
    ]) {
      expect(await carried(call('Bash', { command }))).toBe(CARRIED_SHELL_ASK_REASON);
    }
    // Other plain reads inside the folder still run.
    expect(await carried(call('Bash', { command: 'ls' }))).toBe('runs');
  });
});

describe('a carried turn: the agent’s own files ask (M-C)', () => {
  it('asks before an edit to SOUL.md, NOPE.md, HEARTBEAT.md or MEMORY.md', async () => {
    for (const name of ['SOUL.md', 'NOPE.md', 'HEARTBEAT.md', 'MEMORY.md']) {
      const file = path.join(home, '.dork', name);
      expect(await carried(call('Write', { file_path: file, content: 'x' }))).toBe(
        CARRIED_WRITE_ASK_REASON
      );
      expect(
        await carried(call('Edit', { file_path: file, old_string: 'a', new_string: 'b' }))
      ).toBe(CARRIED_WRITE_ASK_REASON);
    }
    expect(
      await carried(call('Write', { file_path: path.join(home, '.dork', 'memory', 'x.md') }))
    ).toBe(CARRIED_WRITE_ASK_REASON);
  });

  it('still runs an ordinary edit, and asks about a write that names no path', async () => {
    expect(
      await carried(
        call('Edit', { file_path: path.join(home, 'notes.md'), old_string: 'a', new_string: 'b' })
      )
    ).toBe('runs');
    expect(await carried(call('Write', { content: 'x' }))).toBe(CARRIED_WRITE_ASK_REASON);
  });
});

describe('an unmarked turn at Full is unchanged', () => {
  it('runs the same edits and git commands with no card', async () => {
    expect(await unmarked(call('Write', { file_path: '.git/config', content: 'x' }))).toBe('runs');
    expect(await unmarked(call('Write', { file_path: '.dork/SOUL.md', content: 'x' }))).toBe(
      'runs'
    );
    expect(await unmarked(call('Bash', { command: 'git diff' }))).toBe('runs');
  });
});

describe('the two checks on their own', () => {
  it('reads a write tool’s path, and leaves every other tool alone', () => {
    expect(carriedWriteAsks('NotebookEdit', { notebook_path: '.dork/a.ipynb' }, home)).toBe(true);
    expect(carriedWriteAsks('Read', { file_path: '.git/config' }, home)).toBe(false);
    expect(carriedWriteAsks('Write', { file_path: 'src/.gitkeep' }, home)).toBe(false);
  });

  it('tells git by its first word only', () => {
    expect(runsGit('git')).toBe(true);
    expect(runsGit('  git log')).toBe(true);
    expect(runsGit('gitk')).toBe(false);
    expect(runsGit('cat .git/config')).toBe(false);
  });
});
