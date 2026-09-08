import { describe, it, expect } from 'vitest';
import {
  generateCodexHooks,
  generateCursorHooks,
  generateCopilotHooks,
  GENERATED_HOOKS_DESCRIPTION,
  type ClaudeHooksConfig,
} from '../hooks.js';
import { CANONICAL_TO_CLAUDE_EVENT_NAMES } from '../../vendor/rulesync-maps.js';

/** A one-command matcher group, the shape both Claude and Codex use. */
function group(command: string) {
  return [{ hooks: [{ type: 'command', command }] }];
}

describe('generateCodexHooks', () => {
  it('maps the six most common Claude events to Codex event keys (6/6)', () => {
    // Five of these are wired in this repo's own .claude/settings.json today
    // (PreToolUse, PostToolUse, SessionStart, Stop, SubagentStop); every one of
    // the six resolves to a Codex event. The whole-map counts are asserted in the
    // HK-13 block below.
    const claude: ClaudeHooksConfig = {
      PreToolUse: group('a'),
      PostToolUse: group('b'),
      SessionStart: group('c'),
      Stop: group('d'),
      UserPromptSubmit: group('e'),
      SubagentStop: group('f'),
    };
    const { file, dropped } = generateCodexHooks(claude);

    // The event map lives under `hooks`, in the shape Codex documents.
    expect(Object.keys(file).sort()).toEqual(['description', 'hooks']);
    expect(file.description).toBe(GENERATED_HOOKS_DESCRIPTION);
    expect(Object.keys(file.hooks).sort()).toEqual(
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
    const { file, dropped } = generateCodexHooks({ Notification: group('x') });
    expect(file.hooks).toEqual({});
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
    const { file, dropped, warnings } = generateCodexHooks({ Stop: group(command) });

    // Still projected (warn, not drop) and not in the drop list.
    expect(file.hooks).toHaveProperty('Stop');
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
    // Was `PreCompact`, which Copilot's own hooks reference does document and
    // which now maps (DOR-1847). `PostCompact` is in Claude's 30 and in none of
    // Copilot's 14, so it is the honest subject for this drop.
    const { file, dropped } = generateCopilotHooks({ PostCompact: group('x') });
    expect(file.hooks).toEqual({});
    expect(dropped).toHaveLength(1);
    expect(dropped[0].event).toBe('PostCompact');
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

describe('the vendored maps against each vendor’s documented hook set (HK-13)', () => {
  it('maps Claude SessionEnd to Codex SessionEnd, which used to drop as nonexistent', () => {
    // learn.chatgpt.com/docs/hooks (2026-09-07): "When the main thread ends:
    // `SessionEnd` (doesn't run for subagents)". The vendored Codex map carried
    // 10 of the 12 documented events and SessionEnd was not one of them.
    const { file, dropped } = generateCodexHooks({ SessionEnd: group('bye') });
    expect(Object.keys(file.hooks)).toEqual(['SessionEnd']);
    expect(dropped).toEqual([]);
  });

  it('maps the five Copilot events that were dropped as having no equivalent', () => {
    // docs.github.com/en/copilot/reference/hooks-configuration (2026-09-07)
    // documents 14 events; the vendored map targeted 8, so these five Claude
    // events were reported as having no Copilot home when they do.
    const { file, dropped } = generateCopilotHooks({
      PreCompact: group('a'),
      PermissionRequest: group('b'),
      Notification: group('c'),
      PostToolUseFailure: group('d'),
      SubagentStart: group('e'),
    });
    expect(Object.keys(file.hooks).sort()).toEqual([
      'notification',
      'permissionRequest',
      'postToolUseFailure',
      'preCompact',
      'subagentStart',
    ]);
    expect(dropped).toEqual([]);
  });

  it('reaches 12 of Claude’s 30 events on Copilot and 11 on Codex', () => {
    // The count is the claim `meta/harness-sync-capabilities.md` HK-02/HK-13
    // makes, so it is asserted rather than described.
    const everyClaudeEvent: ClaudeHooksConfig = Object.fromEntries(
      Object.values(CANONICAL_TO_CLAUDE_EVENT_NAMES).map((event) => [event, group('x')])
    );
    expect(Object.keys(everyClaudeEvent)).toHaveLength(30);

    expect(Object.keys(generateCopilotHooks(everyClaudeEvent).file.hooks)).toHaveLength(12);
    expect(Object.keys(generateCodexHooks(everyClaudeEvent).file.hooks)).toHaveLength(11);
    expect(Object.keys(generateCursorHooks(everyClaudeEvent).file.hooks)).toHaveLength(10);
  });
});
