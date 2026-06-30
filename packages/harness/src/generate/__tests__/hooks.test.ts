import { describe, it, expect } from 'vitest';
import { generateCodexHooks, type ClaudeHooksConfig } from '../hooks.js';

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
