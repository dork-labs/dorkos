/**
 * The level a chat `session_start` opens starts at (DOR-3107, Dorian 2026-10-19 15:07,
 * Security 15:10): from an unmarked or unknown turn of our own agent, the caller's own level
 * (the agent's, for a chat running at it); from a marked turn, the stricter of the caller's
 * level and the runtime default, never looser than the caller.
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

const { resolveStartPermission } = await import('../session-start-permission.js');

const FULL = 'bypassPermissions';
const DEFAULT = CLAUDE_CODE_CAPABILITIES.permissionModes.default!;

/** A start from a Claude Code chat at `mode`. */
const startFrom = (mode: string, marked: boolean, requested?: string) =>
  resolveStartPermission(
    requested,
    { sessionId: 'caller', permissionMode: mode, runtime: 'claude-code' },
    'claude-code',
    null,
    marked
  );

describe('a chat session_start opens', () => {
  it('starts at the agent’s level from an unmarked or unknown turn', async () => {
    // Unknown is not marked: `markedBoundOf` answers undefined for it, so `marked` is false.
    expect(await startFrom(FULL, false, FULL)).toMatchObject({
      ok: true,
      permission: { mode: FULL },
    });
  });

  it('starts capped at the runtime default from a marked turn, and Full is refused', async () => {
    expect(await startFrom(FULL, true)).toMatchObject({ ok: true, permission: { mode: DEFAULT } });
    expect(await startFrom(FULL, true, FULL)).toMatchObject({
      ok: false,
      code: 'ABOVE_YOUR_LEVEL',
    });
  });

  it('never lifts a marked caller below the default up to it', async () => {
    expect(await startFrom('plan', true, DEFAULT)).toMatchObject({
      ok: false,
      code: 'ABOVE_YOUR_LEVEL',
    });
    expect(await startFrom('plan', true)).toMatchObject({ ok: true, permission: { mode: 'plan' } });
  });

  it('keeps a marked caller with no chat at its own stop when that is stricter', async () => {
    const result = await resolveStartPermission('acceptEdits', null, 'claude-code', 'ask', true);
    expect(result).toMatchObject({ ok: false, code: 'ABOVE_YOUR_LEVEL' });
  });

  it('a marked chat set to never ask still starts only chats that cannot ask', async () => {
    const result = await startFrom('dontAsk', true);
    if (result.ok) expect(result.permission.mode).toBe('dontAsk');
    else expect(result.code).toMatch(/NO_MODE_FITS|ABOVE_YOUR_LEVEL/);
    expect(await startFrom('dontAsk', true, DEFAULT)).toMatchObject({ ok: false });
  });
});
