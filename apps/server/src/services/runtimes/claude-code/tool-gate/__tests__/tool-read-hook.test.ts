/**
 * Claude Code's side of the tool-read mark (DOR-3291): the `PostToolUse` hook marks a turn that
 * fetched a web page or read a file outside the agent's folders, before the model sees the
 * result, and folds the mark into the turn's ceiling. From that call on the held-turn hook asks
 * about the shell and about an edit to the agent's own mini app (DOR-3068: a marked turn's edit
 * waits for a person). A turn that reads only its own files is unchanged.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import type { TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import { marksOf } from '../../../../core/turn-power/turn-levels.js';
import { resetLiveOutsiderTurns } from '../../../../core/turn-power/live-outsider-turns.js';
import { resetOutsiderTurns } from '../../../../session/origin/outsider-turns.js';
import {
  CARRIED_SHELL_ASK_REASON,
  CARRIED_WRITE_ASK_REASON,
  createHeldTurnHook,
} from '../held-turn-hook.js';
import { createToolReadHook } from '../tool-read-hook.js';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tool-read-hook-')));
const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tool-read-elsewhere-')));
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});
const FOLDERS = { cwd: home, roots: [home] };
const signal = { signal: new AbortController().signal };

let counter = 0;
const fresh = () => `tool-read-hook-${(counter += 1)}`;

function call(event: 'PreToolUse' | 'PostToolUse', toolName: string, toolInput: object): HookInput {
  return {
    hook_event_name: event,
    session_id: 's',
    transcript_path: '/tmp/t.jsonl',
    cwd: home,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 't',
    ...(event === 'PostToolUse' ? { tool_response: 'the result' } : {}),
  } as HookInput;
}

/** One Accept-edits turn: the after-the-tool hook, and the before-the-tool hook that asks. */
function turn() {
  const sessionId = fresh();
  const session: {
    permissionMode: 'acceptEdits';
    turnPermissionCeiling?: TurnPermissionCeiling;
  } = { permissionMode: 'acceptEdits' };
  const after = createToolReadHook(session, sessionId, home, FOLDERS);
  const before = createHeldTurnHook(
    session,
    async () => ({ identity: { agentPath: home } }),
    { debug: () => {}, info: () => {} },
    FOLDERS
  );
  return {
    sessionId,
    used: (toolName: string, input: object) =>
      after(call('PostToolUse', toolName, input), 't', signal),
    asks: async (toolName: string, input: object) => {
      const out = (await before(call('PreToolUse', toolName, input), 't', signal)) as {
        hookSpecificOutput?: { permissionDecisionReason?: string };
      };
      return out.hookSpecificOutput?.permissionDecisionReason ?? 'runs';
    },
  };
}

const MINI_APP = () => path.join(home, '.dork', 'extensions', 'tally', 'server.ts');

beforeEach(() => {
  resetLiveOutsiderTurns();
  resetOutsiderTurns();
});
afterEach(() => {
  resetLiveOutsiderTurns();
  resetOutsiderTurns();
});

describe('a web read marks the turn before the model sees the page', () => {
  it('then the shell and an edit to its own mini app ask', async () => {
    const t = turn();
    // Before the read: the turn runs both.
    expect(await t.asks('Bash', { command: 'python3 -c 1' })).toBe('runs');
    expect(await t.asks('Write', { file_path: MINI_APP(), content: 'x' })).toBe('runs');

    await t.used('WebFetch', { url: 'https://example.test/post' });
    expect(marksOf(t.sessionId, home)).toMatchObject({ outsider: true, toolRead: true });
    expect(await t.asks('Bash', { command: 'python3 -c 1' })).toBe(CARRIED_SHELL_ASK_REASON);
    // The mini app keeps path trust only while clean turns edit it (DOR-3068).
    expect(await t.asks('Write', { file_path: MINI_APP(), content: 'x' })).toBe(
      CARRIED_WRITE_ASK_REASON
    );
    // Ordinary work in its own folder still runs.
    expect(await t.asks('Write', { file_path: path.join(home, 'notes.md'), content: 'x' })).toBe(
      'runs'
    );
  });

  it('a file read outside the agent’s folders marks it too', async () => {
    const t = turn();
    await t.used('Read', { file_path: path.join(outside, 'mail.eml') });
    expect(marksOf(t.sessionId, home).toolRead).toBe(true);
    expect(await t.asks('Bash', { command: 'python3 -c 1' })).toBe(CARRIED_SHELL_ASK_REASON);
  });
});

describe('a turn that reads only its own files is unchanged', () => {
  it('marks nothing and asks nothing', async () => {
    const t = turn();
    await t.used('Read', { file_path: path.join(home, 'README.md') });
    await t.used('Grep', { pattern: 'x', path: home });
    await t.used('Bash', { command: 'ls' });
    expect(marksOf(t.sessionId, home)).toEqual({});
    expect(await t.asks('Bash', { command: 'python3 -c 1' })).toBe('runs');
    expect(await t.asks('Write', { file_path: MINI_APP(), content: 'x' })).toBe('runs');
  });
});
