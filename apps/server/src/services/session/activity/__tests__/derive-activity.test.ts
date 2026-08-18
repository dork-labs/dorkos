import { describe, it, expect } from 'vitest';
import { deriveSessionActivity, ACTIVITY_TARGET_MAX_LENGTH } from '../derive-activity.js';

describe('deriveSessionActivity', () => {
  it('returns nothing for a nameless tool call', () => {
    // Purpose: an empty name says nothing about what the agent is doing, and a
    // reading that says nothing must be absent rather than empty — the client
    // ladder falls back to "Working…" only when there is no activity at all.
    expect(deriveSessionActivity('', '{"file_path":"/a/b.ts"}')).toBeUndefined();
    expect(deriveSessionActivity('   ', undefined)).toBeUndefined();
  });

  it('carries a file path as its basename, not the whole path', () => {
    // Purpose: the target is what a person reads at a glance in a sidebar row.
    expect(
      deriveSessionActivity('Edit', '{"file_path":"/repo/apps/client/lane-state.ts"}')
    ).toEqual({ toolName: 'Edit', target: 'lane-state.ts' });
    expect(deriveSessionActivity('Read', '{"file_path":"/repo/README.md"}')).toEqual({
      toolName: 'Read',
      target: 'README.md',
    });
  });

  it('carries a command excerpt for shell tools, whatever the runtime calls them', () => {
    // Purpose: claude-code says `Bash`, codex synthesizes `Shell`, opencode
    // passes `bash` through verbatim. All three are the same act.
    expect(deriveSessionActivity('Bash', '{"command":"pnpm verify"}')).toEqual({
      toolName: 'Bash',
      target: 'pnpm verify',
    });
    expect(deriveSessionActivity('Shell', '{"command":"git status"}')).toEqual({
      toolName: 'Shell',
      target: 'git status',
    });
    expect(deriveSessionActivity('bash', '{"command":"ls -la"}')).toEqual({
      toolName: 'bash',
      target: 'ls -la',
    });
  });

  it('truncates a long target instead of putting a wall of text on the wire', () => {
    // The EXACT length, not a bound: an upper bound is satisfied by a truncate
    // that cuts far too much (12 characters would pass it just as well as 40),
    // so it cannot tell a correct cut from a destructive one.
    const command = 'x'.repeat(200);
    const activity = deriveSessionActivity('Bash', JSON.stringify({ command }));
    expect(activity?.target).toBe(`${'x'.repeat(ACTIVITY_TARGET_MAX_LENGTH)}\u2026`);
    expect(activity?.target).toHaveLength(ACTIVITY_TARGET_MAX_LENGTH + 1);
  });

  it('collapses a multi-line command to its first line', () => {
    // Purpose: a heredoc or a chained script would otherwise put newlines into
    // a one-line status row.
    expect(deriveSessionActivity('Bash', '{"command":"pnpm build\\npnpm test"}')?.target).toBe(
      'pnpm build'
    );
  });

  it('carries the host for a web fetch and the query for a web search', () => {
    expect(deriveSessionActivity('WebFetch', '{"url":"https://dorkos.ai/docs/agents"}')).toEqual({
      toolName: 'WebFetch',
      target: 'dorkos.ai',
    });
    expect(deriveSessionActivity('WebSearch', '{"query":"express 5 routing"}')).toEqual({
      toolName: 'WebSearch',
      target: 'express 5 routing',
    });
  });

  it('names the first file a codex patch touches', () => {
    // Purpose: codex synthesizes `ApplyPatch` with a `changes` array rather than
    // a file path, so the shared field lookup cannot reach it.
    const input = JSON.stringify({
      changes: [
        { kind: 'modify', path: '/repo/apps/server/src/index.ts' },
        { kind: 'add', path: '/repo/other.ts' },
      ],
    });
    expect(deriveSessionActivity('ApplyPatch', input)).toEqual({
      toolName: 'ApplyPatch',
      target: 'index.ts',
    });
  });

  it('keeps the tool name and drops the target when the input is unusable', () => {
    // Purpose: "which tool" is still true when "on what" is not knowable. The
    // ladder degrades to a generic phrase rather than guessing an argument.
    expect(deriveSessionActivity('Edit', 'not json at all')).toEqual({ toolName: 'Edit' });
    expect(deriveSessionActivity('Edit', undefined)).toEqual({ toolName: 'Edit' });
    expect(deriveSessionActivity('Bash', '{"description":"only a description"}')).toEqual({
      toolName: 'Bash',
    });
  });

  it('keeps an unknown tool name verbatim, with no invented target', () => {
    // Purpose: opencode and MCP servers ship names this list has never seen.
    // The honest answer is the name itself.
    expect(deriveSessionActivity('mcp__slack__send_message', '{"channel":"#eng"}')).toEqual({
      toolName: 'mcp__slack__send_message',
    });
    expect(deriveSessionActivity('some_future_tool', '{"file_path":"/a/b.ts"}')).toEqual({
      toolName: 'some_future_tool',
    });
  });

  it('ignores a target field that is present but not a string', () => {
    // Purpose: `String(...)` on an object yields "[object Object]", which is
    // worse than saying nothing.
    expect(deriveSessionActivity('Read', '{"file_path":{"nested":true}}')).toEqual({
      toolName: 'Read',
    });
    expect(deriveSessionActivity('Bash', '{"command":""}')).toEqual({ toolName: 'Bash' });
  });
});
