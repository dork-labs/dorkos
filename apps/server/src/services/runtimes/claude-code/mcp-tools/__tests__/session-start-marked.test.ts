/**
 * The level a chat `session_start` opens starts at (DOR-3107, Dorian 2026-10-19 15:07,
 * Security 15:10): from an unmarked or unknown turn of our own agent, the caller's own level
 * (the agent's, for a chat running at it); from a marked turn, the stricter of the caller's
 * level and the runtime default, never looser than the caller.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { CARRIED_OUTSIDER_LEVEL, ceilingHoldsForOutsider } from '@dorkos/shared/permission-semantics';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtime-constants.js';
import { recordTurnLevels } from '../../../../core/turn-power/turn-levels.js';
import { marksOnlyBound, outsiderStartCeiling } from '../session-start-facts.js';

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

  it('a marked chat set to Full, read at Full and passed the marks alone, starts at Full (DOR-3394)', async () => {
    // What the handler hands on for a chat set to Full: its own mode, and `marked` false,
    // because the bound it carries is the marks alone (below). Named or not.
    const facts = { personSetStop: 'autonomy' as const, fullUnnamedAllowed: true };
    const fromFull = (requested?: string) =>
      resolveStartPermission(
        requested,
        { sessionId: 'caller', permissionMode: FULL, runtime: 'claude-code', chosenFull: true },
        'claude-code',
        null,
        ceilingHoldsForOutsider(marksOnlyBound(['runtime-default', CARRIED_OUTSIDER_LEVEL])),
        facts
      );
    expect(await fromFull(FULL)).toMatchObject({ ok: true, permission: { mode: FULL } });
    expect(await fromFull()).toMatchObject({ ok: true, permission: { mode: FULL } });
    expect(await fromFull('acceptEdits')).toMatchObject({
      ok: true,
      permission: { mode: 'acceptEdits' },
    });
  });

  it('a marked chat set to never ask still starts only chats that cannot ask', async () => {
    const result = await startFrom('dontAsk', true);
    if (result.ok) expect(result.permission.mode).toBe('dontAsk');
    else expect(result.code).toMatch(/NO_MODE_FITS|ABOVE_YOUR_LEVEL/);
    expect(await startFrom('dontAsk', true, DEFAULT)).toMatchObject({ ok: false });
  });
});

describe('the bound a marked start carries (DOR-3394)', () => {
  /** A Full chat whose last turn a hold bound, through the real level seam. */
  async function heldChat(sessionId: string) {
    const runtime = recordTurnLevels(
      {
        type: 'claude-code',
        getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
        async *sendMessage(): AsyncGenerator<StreamEvent> {
          yield { type: 'done', data: {} } as StreamEvent;
        },
      } as unknown as AgentRuntime,
      () => FULL
    );
    for await (const _event of runtime.sendMessage(sessionId, 'hi', {
      permissionCeiling: 'runtime-default',
    })) {
      // drain
    }
  }

  it('is nothing from a chat a hold bound, at any level: the hold stays on that turn', async () => {
    await heldChat('full-caller');
    await heldChat('held-caller');
    expect(
      outsiderStartCeiling({
        agentPath: '/agents/ana',
        chat: { sessionId: 'full-caller', chosenFull: true },
      })
    ).toEqual({});
    expect(
      outsiderStartCeiling({ agentPath: '/agents/ana', chat: { sessionId: 'held-caller' } })
    ).toEqual({});
  });

  it('keeps every teammate origin, with no read-only cap', () => {
    const teammate = [{ roomId: 'r', authorId: 'pat' }];
    expect(
      marksOnlyBound(['runtime-default', { asks: 'always', reach: 'read', teammate }] as never)
    ).toEqual({ ...CARRIED_OUTSIDER_LEVEL, teammate });
  });
});
