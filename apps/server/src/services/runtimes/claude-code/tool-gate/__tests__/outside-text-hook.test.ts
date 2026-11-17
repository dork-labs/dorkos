/**
 * A tool call that reads outside text marks its turn (DOR-3969, spec §4.7): which calls count on
 * each runtime, and Claude Code's `PreToolUse` hook, which marks before the tool runs. That a mark
 * then holds a send is pinned end to end in `connectors/execution/__tests__/read-marks-turn.test.ts`.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { marksOf, recordTurnLevels } from '../../../../core/turn-power/turn-levels.js';
import { marksHold } from '../../../../core/turn-power/turn-marks.js';
import { resetChosenTurns } from '../../../../core/turn-power/full-autonomy.js';
import { resetLiveOutsiderTurns } from '../../../../core/turn-power/live-outsider-turns.js';
import {
  CLAUDE_CODE_OUTSIDE_TEXT_MATCHER,
  toolReadsOutsideText,
} from '../../../shared/tools/outside-text-tools.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtime-constants.js';
import { UNMARKED_REFUSAL, outsideTextHookMatcher } from '../outside-text-hook.js';

const AGENT = '/agents/wren';
let counter = 0;
const fresh = () => `outside-text-hook-${(counter += 1)}`;

/**
 * The CLI's matcher rule, transcribed as `classifier-context.test.ts` transcribes it: a matcher of
 * word characters alone is a list of exact names; anything else is a regular expression.
 */
const cliWouldRunHook = (matcher: string, toolName: string): boolean => {
  if (/^[a-zA-Z0-9_|, -]+$/.test(matcher)) {
    return matcher
      .split(/[|,]/)
      .map((entry) => entry.trim())
      .includes(toolName);
  }
  return new RegExp(matcher).test(toolName);
};

/** Run one turn in a chat set to Full autonomy, so its level is recorded. */
async function ranAtFull(sessionId: string) {
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => 'bypassPermissions'
  );
  for await (const _event of runtime.sendMessage(sessionId, 'hi')) {
    // drain
  }
}

/** Fire the hook for one call in this chat; what it answered. */
async function call(sessionId: string, toolName: string) {
  const matcher = outsideTextHookMatcher(() => sessionId, AGENT);
  if (!cliWouldRunHook(matcher.matcher!, toolName)) return 'not on the wire';
  return matcher.hooks[0]!(
    {
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: {},
      tool_use_id: 'call-1',
      session_id: sessionId,
      transcript_path: '/tmp/made-up.jsonl',
      cwd: AGENT,
    } as never,
    'call-1',
    { signal: new AbortController().signal }
  );
}

describe('which tool calls read outside text', () => {
  it.each([
    ['claude-code', 'WebFetch'],
    ['claude-code', 'WebSearch'],
    ['claude-code', 'mcp__notion__search'],
    ['claude-code', 'mcp__plugin_tracker__get_issue'],
    ['claude-code', 'ReadMcpResourceTool'],
    ['claude-code', 'ListMcpResourcesTool'],
    ['codex', 'WebSearch'],
    ['codex', 'mcp__notion__search'],
    ['opencode', 'webfetch'],
    ['opencode', 'websearch'],
    ['opencode', 'notion_search'],
    ['opencode', 'some_tool_nobody_named'],
    ['opencode', ''],
    ['opencode', 'task'],
    ['doe', 'web_fetch'],
    ['doe', 'mcp_notion_search_0123456789abcdef0123'],
  ])('%s %s does', (runtime, name) => {
    expect(toolReadsOutsideText(runtime, name)).toBe(true);
  });

  it.each([
    ['claude-code', 'Read'],
    ['claude-code', 'Grep'],
    ['claude-code', 'Glob'],
    ['claude-code', 'Bash'],
    ['claude-code', 'Edit'],
    ['claude-code', 'mcp__dorkos__read_room_history'],
    ['claude-code', 'mcp__dorkos_connections__connectors_execute_write'],
    ['codex', 'Shell'],
    ['codex', 'ApplyPatch'],
    ['codex', 'mcp__dorkos__chat_read'],
    ['codex', 'mcp__dorkos_connections__connectors_execute_write'],
    ['opencode', 'read'],
    ['opencode', 'grep'],
    ['opencode', 'bash'],
    ['opencode', 'dorkos_read_room_history'],
    ['opencode', 'dorkos_connections_connectors_execute_write'],
    ['doe', 'read'],
    ['doe', 'search'],
    ['doe', 'mcp_dorkos_connections_connectors_execut_0123456789abcdef0123'],
  ])('%s %s does not', (runtime, name) => {
    expect(toolReadsOutsideText(runtime, name)).toBe(false);
  });
});

describe("Claude Code's hook marks the turn before the tool runs", () => {
  beforeEach(() => {
    resetChosenTurns();
    resetLiveOutsiderTurns();
  });
  afterEach(() => {
    resetChosenTurns();
    resetLiveOutsiderTurns();
  });

  const held = (chat: string) => marksHold(marksOf(chat, AGENT));

  it('is a pattern the CLI reads as one, not a list of exact names', () => {
    expect(/^[a-zA-Z0-9_|, -]+$/.test(CLAUDE_CODE_OUTSIDE_TEXT_MATCHER)).toBe(false);
    const reached = ['WebFetch', 'WebSearch', 'ReadMcpResourceTool', 'mcp__notion__search'];
    for (const name of reached) {
      expect(cliWouldRunHook(CLAUDE_CODE_OUTSIDE_TEXT_MATCHER, name), name).toBe(true);
    }
    for (const name of ['Read', 'Grep', 'Bash', 'WebFetchLater', 'xmcp__notion__search']) {
      expect(cliWouldRunHook(CLAUDE_CODE_OUTSIDE_TEXT_MATCHER, name), name).toBe(false);
    }
  });

  it.each(['WebFetch', 'WebSearch', 'mcp__notion__search'])('%s marks the turn', async (name) => {
    const chat = fresh();
    await ranAtFull(chat);
    expect(await call(chat, name)).toEqual({});
    expect(held(chat)).toBe(true);
  });

  it('refuses the read when the turn cannot be marked', async () => {
    const matcher = outsideTextHookMatcher(() => {
      throw new Error('the chat is gone');
    }, AGENT);
    const answer = await matcher.hooks[0]!(
      { hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: {} } as never,
      'call-1',
      { signal: new AbortController().signal }
    );
    expect(answer).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: UNMARKED_REFUSAL,
      },
    });
  });

  it('a turn that only reads local files stays clean', async () => {
    const chat = fresh();
    await ranAtFull(chat);
    for (const name of ['Read', 'Grep', 'Glob', 'Bash']) await call(chat, name);
    expect(held(chat)).toBe(false);
  });

  it("DorkOS's own tools are left to the server, which marks the ones that return outside text", async () => {
    const chat = fresh();
    await ranAtFull(chat);
    await call(chat, 'mcp__dorkos__read_room_history');
    expect(held(chat)).toBe(false);
  });
});
