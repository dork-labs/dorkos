/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import type { HookInput, Options } from '@anthropic-ai/claude-agent-sdk';
import {
  WITHHELD_BROWSER_TOOL_MESSAGE,
  applyBrowserToolDeny,
  browserToolDenyRules,
  browserToolHookMatcher,
} from '../browser-tool-deny.js';

/** Ask the hook about one tool call. */
async function hookAnswer(toolName: string): Promise<unknown> {
  const [hook] = browserToolHookMatcher().hooks;
  return hook!(
    {
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: {},
      tool_use_id: 'toolu_1',
      session_id: 's',
      transcript_path: '/t',
      cwd: '/c',
    } as HookInput,
    'toolu_1',
    { signal: new AbortController().signal }
  );
}

describe('browserToolDenyRules', () => {
  it('names the tool on every server, spelled the way Claude Code spells a server', () => {
    expect(browserToolDenyRules(['browser', 'my.browser', 'notes'])).toEqual([
      'mcp__browser__browser_run_code_unsafe',
      'mcp__my_browser__browser_run_code_unsafe',
      'mcp__notes__browser_run_code_unsafe',
    ]);
  });

  it('leaves browser_evaluate alone', () => {
    expect(browserToolDenyRules(['browser']).join()).not.toContain('browser_evaluate');
  });
});

describe('applyBrowserToolDeny', () => {
  it('adds the rules beside the launch’s other denies and keeps its allows', () => {
    const options: Options = {
      mcpServers: { browser: { type: 'stdio', command: 'npx' }, dorkos: { type: 'sdk' } as never },
      settings: { permissions: { deny: ['Read(/secret)'], allow: ['mcp__browser__*'] } },
    };
    applyBrowserToolDeny(options);
    expect(options.settings).toEqual({
      permissions: {
        deny: [
          'Read(/secret)',
          'mcp__browser__browser_run_code_unsafe',
          'mcp__dorkos__browser_run_code_unsafe',
        ],
        allow: ['mcp__browser__*'],
      },
    });
  });

  it('changes nothing when the turn has no servers', () => {
    const options: Options = { settings: { fastMode: true } };
    applyBrowserToolDeny(options);
    expect(options.settings).toEqual({ fastMode: true });
  });
});

describe('browserToolHookMatcher', () => {
  it('is a pattern, so the CLI reads it as a regex', () => {
    expect(browserToolHookMatcher().matcher).toMatch(/^\^/);
  });

  it('refuses the tool on any server, including one DorkOS never named', async () => {
    for (const name of [
      'mcp__browser__browser_run_code_unsafe',
      'mcp__playwright__browser_run_code_unsafe',
      'mcp__plugin_x_pw__browser_run_code_unsafe',
    ]) {
      expect(await hookAnswer(name)).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: WITHHELD_BROWSER_TOOL_MESSAGE,
        },
      });
    }
  });

  it('answers nothing for every other tool, browser_evaluate included', async () => {
    for (const name of [
      'mcp__browser__browser_evaluate',
      'mcp__browser__browser_snapshot',
      'mcp__browser__browser_run_code_unsafe_v2',
      'browser_run_code_unsafe',
      'Bash',
    ]) {
      expect(await hookAnswer(name)).toEqual({});
    }
  });
});
