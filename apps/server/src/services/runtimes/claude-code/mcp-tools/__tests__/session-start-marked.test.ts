/**
 * The level a chat `session_start` opens starts at (DOR-3107, Dorian 2026-10-19 15:07,
 * Security 15:10): from an unmarked or unknown turn of our own agent, the caller's own
 * level (the agent's, for a chat running at it); from a marked turn, the runtime default.
 */
import { describe, expect, it, vi } from 'vitest';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtime-constants.js';

vi.mock('../../../../core/runtime-registry.js', () => ({
  runtimeRegistry: {
    computerRuntimeForAgentPath: () => undefined,
    has: (type: string) => type === 'claude-code',
    get: () => ({ getCapabilities: () => CLAUDE_CODE_CAPABILITIES }),
    getSessionSettings: async () => null,
  },
}));

const { resolveStartPermission, startingChatFor } = await import('../session-start-permission.js');

const FULL = 'bypassPermissions';
const DEFAULT = CLAUDE_CODE_CAPABILITIES.permissionModes.default!;
const AGENT_CHAT = { sessionId: 'caller', permissionMode: FULL, runtime: 'claude-code' };

/** Start a chat from the agent's chat at Full autonomy, naming Full as the tool requires. */
const startFrom = (marked: boolean, requested: string | null = FULL) =>
  resolveStartPermission(
    requested ?? undefined,
    startingChatFor(AGENT_CHAT, 'claude-code', marked),
    'claude-code'
  );

describe('a chat session_start opens', () => {
  it('starts at the agent’s level from an unmarked turn', async () => {
    expect(await startFrom(false)).toMatchObject({ ok: true, permission: { mode: FULL } });
  });

  it('starts at the agent’s level from a turn whose marks are unknown (no recorded level)', async () => {
    // Unknown is not marked: `markedBoundOf` answers undefined, so the caller is read as it is.
    expect(startingChatFor(AGENT_CHAT, 'claude-code', false)).toBe(AGENT_CHAT);
    expect(await startFrom(false)).toMatchObject({ ok: true, permission: { mode: FULL } });
  });

  it('starts capped at the runtime default from a marked turn, and Full is refused', async () => {
    expect(await startFrom(true, null)).toMatchObject({
      ok: true,
      permission: { mode: DEFAULT },
    });
    expect(await startFrom(true)).toMatchObject({ ok: false, code: 'ABOVE_YOUR_LEVEL' });
  });

  it('caps a marked caller with no chat too', () => {
    expect(startingChatFor(null, 'claude-code', true)).toEqual({
      sessionId: null,
      permissionMode: DEFAULT,
      runtime: 'claude-code',
    });
  });
});
