import { describe, it, expect } from 'vitest';
import {
  generateCodexHooks,
  generateCursorHooks,
  generateCopilotHooks,
  type ClaudeHooksConfig,
} from '../hooks.js';

/** A one-command matcher group, the shape both Claude and Codex use. */
function group(command: string) {
  return [{ hooks: [{ type: 'command', command }] }];
}

describe('generateCodexHooks', () => {
  it('maps all six repo Claude events to Codex event keys (6/6)', () => {
    // The six events wired in .claude/settings.json each resolve to a Codex event.
    const claude: ClaudeHooksConfig = {
      PreToolUse: group('a'),
      PostToolUse: group('b'),
      SessionStart: group('c'),
      Stop: group('d'),
      UserPromptSubmit: group('e'),
      SubagentStop: group('f'),
    };
    const { hooks, dropped } = generateCodexHooks(claude);

    expect(Object.keys(hooks).sort()).toEqual(
      [
        'PostToolUse',
        'PreToolUse',
        'SessionStart',
        'Stop',
        'SubagentStop',
        'UserPromptSubmit',
      ].sort()
    );
    expect(dropped).toEqual([]);
  });

  it('drops a Claude event Codex has no equivalent for, with a reason', () => {
    // Notification exists in Claude but not Codex → an honest drop, not silent loss.
    const { hooks, dropped } = generateCodexHooks({ Notification: group('x') });
    expect(hooks).toEqual({});
    expect(dropped).toHaveLength(1);
    expect(dropped[0].event).toBe('Notification');
    expect(dropped[0].reason).toMatch(/Codex/);
  });

  it('drops an event with no canonical mapping, with a reason', () => {
    // A made-up event name has no canonical form → dropped with a reason.
    const { dropped } = generateCodexHooks({ MadeUpEvent: group('z') });
    expect(dropped[0].event).toBe('MadeUpEvent');
    expect(dropped[0].reason).toMatch(/canonical/);
  });

  it('warns (but still projects) a hook command with a Claude-only ${CLAUDE_PLUGIN_ROOT} token', () => {
    // The flow plugin's Stop hook uses ${CLAUDE_PLUGIN_ROOT}, which Codex never
    // resolves — warn-and-project, so the operator is told the hook may not work.
    const command =
      'cd "$(git rev-parse --show-toplevel)" && node "${CLAUDE_PLUGIN_ROOT}/hooks/flow-loop.mjs"';
    const { hooks, dropped, warnings } = generateCodexHooks({ Stop: group(command) });

    // Still projected (warn, not drop) and not in the drop list.
    expect(hooks).toHaveProperty('Stop');
    expect(dropped).toEqual([]);

    // A single warning naming the event and the offending token.
    expect(warnings).toHaveLength(1);
    expect(warnings[0].event).toBe('Stop');
    expect(warnings[0].reason).toContain('${CLAUDE_PLUGIN_ROOT}');
    expect(warnings[0].reason).toMatch(/Codex/);
  });

  it('catches other ${CLAUDE_*} substitution vars, not just CLAUDE_PLUGIN_ROOT', () => {
    const { warnings } = generateCodexHooks({
      PreToolUse: group('echo "${CLAUDE_PROJECT_DIR}/x"'),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toContain('${CLAUDE_PROJECT_DIR}');
  });

  it('does not warn for a portable command with no Claude-only token', () => {
    const { warnings } = generateCodexHooks({ Stop: group('echo bye') });
    expect(warnings).toEqual([]);
  });
});

describe('generateCursorHooks', () => {
  it('maps mappable events into a { version, hooks } file with FLAT entries', () => {
    // Cursor uses camelCase 1:1 event names and a flat entry (matcher on the
    // entry, no nested `hooks` group). PreToolUse -> preToolUse, Stop -> stop.
    const claude: ClaudeHooksConfig = {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'a' }] }],
      Stop: group('d'),
    };
    const { file, dropped } = generateCursorHooks(claude);

    expect(file.version).toBe(1);
    expect(Object.keys(file.hooks).sort()).toEqual(['preToolUse', 'stop']);
    // Flat entry: type + command + the matcher lifted from the source group.
    expect(file.hooks.preToolUse).toEqual([{ type: 'command', command: 'a', matcher: 'Bash' }]);
    // A group with no matcher yields an entry with no matcher key.
    expect(file.hooks.stop).toEqual([{ type: 'command', command: 'd' }]);
    expect(dropped).toEqual([]);
  });

  it('drops a Claude event Cursor has no equivalent for, with a Cursor-named reason', () => {
    // Cursor's map has no `permissionRequest` target -> honest drop naming Cursor.
    const { file, dropped } = generateCursorHooks({ PermissionRequest: group('x') });
    expect(file.hooks).toEqual({});
    expect(dropped).toHaveLength(1);
    expect(dropped[0].event).toBe('PermissionRequest');
    expect(dropped[0].reason).toMatch(/Cursor/);
  });

  it('warns naming Cursor (not Codex) when a projected command carries a Claude-only token', () => {
    // FND-11: the warning must name the actual target harness.
    const { file, warnings } = generateCursorHooks({
      Stop: group('node "${CLAUDE_PLUGIN_ROOT}/h.mjs"'),
    });
    expect(file.hooks).toHaveProperty('stop'); // still projected (warn, not drop)
    expect(warnings).toHaveLength(1);
    expect(warnings[0].event).toBe('Stop');
    expect(warnings[0].reason).toContain('${CLAUDE_PLUGIN_ROOT}');
    expect(warnings[0].reason).toMatch(/Cursor/);
    expect(warnings[0].reason).not.toMatch(/Codex/);
  });

  it('concatenates multiple source commands for the same event into flat entries', () => {
    const { file } = generateCursorHooks({
      Stop: [
        { hooks: [{ type: 'command', command: 'one' }] },
        { hooks: [{ type: 'command', command: 'two' }] },
      ],
    });
    expect(file.hooks.stop.map((h) => h.command)).toEqual(['one', 'two']);
  });
});

describe('generateCopilotHooks', () => {
  it('maps events to Copilot event names in a { version, hooks } file', () => {
    // Copilot renames: UserPromptSubmit -> userPromptSubmitted, Stop -> agentStop.
    const claude: ClaudeHooksConfig = {
      PreToolUse: group('a'),
      UserPromptSubmit: group('b'),
      Stop: group('c'),
    };
    const { file, dropped } = generateCopilotHooks(claude);

    expect(file.version).toBe(1);
    expect(Object.keys(file.hooks).sort()).toEqual([
      'agentStop',
      'preToolUse',
      'userPromptSubmitted',
    ]);
    expect(file.hooks.agentStop).toEqual([{ type: 'command', command: 'c' }]);
    expect(dropped).toEqual([]);
  });

  it('drops a Claude event Copilot has no equivalent for, with a Copilot-named reason', () => {
    // Copilot's cloud-agent surface has no `preCompact` -> honest drop naming Copilot.
    const { file, dropped } = generateCopilotHooks({ PreCompact: group('x') });
    expect(file.hooks).toEqual({});
    expect(dropped).toHaveLength(1);
    expect(dropped[0].event).toBe('PreCompact');
    expect(dropped[0].reason).toMatch(/Copilot/);
  });

  it('warns naming Copilot when a projected command carries a Claude-only token', () => {
    const { file, warnings } = generateCopilotHooks({
      Stop: group('node "${CLAUDE_PLUGIN_ROOT}/h.mjs"'),
    });
    expect(file.hooks).toHaveProperty('agentStop');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toContain('${CLAUDE_PLUGIN_ROOT}');
    expect(warnings[0].reason).toMatch(/Copilot/);
  });
});
