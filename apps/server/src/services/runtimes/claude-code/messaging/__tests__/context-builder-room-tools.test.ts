/**
 * Pins WHERE the react-instead-of-a-word nudge lives (DOR-1234): the
 * claude-code-only `<room_tools>` block inside {@link buildSystemPromptAppend},
 * never the runtime-neutral `<room_context>` body every adapter shares
 * (`runtimes/shared/room-context-block.ts`). Codex and OpenCode agents render
 * only the shared block, so a nudge that named `react_to_room_entry` — a tool
 * only this runtime's in-session MCP server carries — would tell a runtime
 * with no reaction tool to react anyway. `room-context-block.test.ts` already
 * pins the shared block's exact text and contains no mention of it; this file
 * pins the positive half.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildSystemPromptAppend } from '../context-builder.js';

vi.mock('../../../../core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(undefined) },
}));
vi.mock('../../../relay/relay-state.js', () => ({
  isRelayEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../tasks/task-state.js', () => ({
  isTasksEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn().mockResolvedValue(null),
}));

describe('the claude-code system prompt append', () => {
  it('teaches react_to_room_entry with the ack-only nudge, in the room_tools block', async () => {
    const prompt = await buildSystemPromptAppend('/tmp/dor-1234-probe-cwd');
    expect(prompt).toContain('<room_tools>');
    expect(prompt).toContain('react_to_room_entry');
    expect(prompt).toContain('"no reply needed", "just ack this"');
    expect(prompt).toContain('✅ seen, 👍 agreed, 👀 looking');
    expect(prompt).toContain('and when\n    something needs saying, say it');
  });
});
