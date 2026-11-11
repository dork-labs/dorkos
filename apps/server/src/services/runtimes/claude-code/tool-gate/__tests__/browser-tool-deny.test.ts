/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import type { HookInput, Options } from '@anthropic-ai/claude-agent-sdk';
import {
  BROWSER_FILE_MESSAGE,
  WITHHELD_BROWSER_TOOL_MESSAGE,
  applyBrowserToolDeny,
  browserToolDenyRules,
  browserToolHookMatcher,
} from '../browser-tool-deny.js';

/** Ask the hook about one tool call. */
async function hookAnswer(toolName: string, toolInput: unknown = {}): Promise<unknown> {
  const [hook] = browserToolHookMatcher().hooks;
  return hook!(
    {
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: toolInput,
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
    expect(browserToolDenyRules(['browser', 'my.browser'])).toEqual([
      'mcp__browser__browser_run_code_unsafe',
      'mcp__browser__browser_network_request',
      'mcp__my_browser__browser_run_code_unsafe',
      'mcp__my_browser__browser_network_request',
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
          'mcp__browser__browser_network_request',
          'mcp__dorkos__browser_run_code_unsafe',
          'mcp__dorkos__browser_network_request',
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

  const refused = (reason: string) => ({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });

  it('matches every browser tool, in any case, wherever the server name ends', () => {
    const matcher = new RegExp(browserToolHookMatcher().matcher!);
    expect(matcher.test('mcp__My-PW_Server__Browser_Run_Code_Unsafe')).toBe(true);
    expect(matcher.test('MCP__x__BROWSER_SNAPSHOT')).toBe(true);
    expect(matcher.test('mcp__notes__search')).toBe(false);
    expect(matcher.test('Bash')).toBe(false);
  });

  it('refuses the withheld tools on any server, in any case, including one DorkOS never named', async () => {
    for (const name of [
      'mcp__browser__browser_run_code_unsafe',
      'mcp__playwright__browser_run_code_unsafe',
      'mcp__plugin_x_pw__browser_run_code_unsafe',
      'mcp__My-PW_Server__Browser_Run_Code_Unsafe',
      'mcp__PERSONAL__BROWSER_RUN_CODE_UNSAFE',
      'mcp__browser__browser_network_request',
      'mcp__Odd-Name_2__Browser_Network_Request',
    ]) {
      expect(await hookAnswer(name)).toEqual(refused(WITHHELD_BROWSER_TOOL_MESSAGE));
    }
  });

  it('refuses a browser call that names a file, and lets the same call run without it', async () => {
    const cases: [string, Record<string, unknown>][] = [
      ['mcp__browser__browser_take_screenshot', { filename: 'shot.png' }],
      ['mcp__browser__browser_evaluate', { function: '() => 1', filename: 'out.json' }],
      ['mcp__browser__browser_snapshot', { filename: '../../.dork/browser/storage-state.json' }],
      ['mcp__browser__browser_console_messages', { filename: 'log.txt' }],
      ['mcp__browser__browser_network_requests', { filename: 'net.log' }],
      [
        'mcp__browser__browser_file_upload',
        { paths: ['/Users/me/.dork/browser/storage-state.json'] },
      ],
      ['mcp__Odd-Name__Browser_Drop', { paths: [] }],
    ];
    for (const [name, input] of cases) {
      expect(await hookAnswer(name, input)).toEqual(refused(BROWSER_FILE_MESSAGE));
      const { filename: _f, paths: _p, ...rest } = input;
      expect(await hookAnswer(name, rest)).toEqual({});
    }
  });

  it('answers nothing for every other browser call, browser_evaluate included', async () => {
    for (const name of [
      'mcp__browser__browser_evaluate',
      'mcp__browser__browser_snapshot',
      'mcp__browser__browser_network_requests',
      'mcp__browser__browser_run_code_unsafe_v2',
    ]) {
      expect(await hookAnswer(name, {})).toEqual({});
    }
  });

  it('leaves tools that are not a browser’s alone, file arguments and all', async () => {
    for (const name of ['mcp__notes__save', 'browser_run_code_unsafe', 'Write']) {
      expect(await hookAnswer(name, { filename: 'x', paths: ['y'] })).toEqual({});
    }
  });
});
