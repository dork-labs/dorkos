/**
 * A Claude Code conversation set to `dontAsk` keeps `dontAsk` on a stranger's turn (spec
 * `official-community-space` D10, D11). `dontAsk` is the one SDK mode DorkOS does not declare,
 * so the generic clamp would read it as unknown and fall back to the runtime's default, which
 * asks: looser than a mode that refuses whatever the agent's allow rules do not permit. The
 * official space's host agent depends on this, because every post it answers is a stranger's.
 *
 * Each case fails if `clampClaudeMode`'s `dontAsk` rule is removed, or widened past a ceiling
 * that admits the runtime's default.
 */
import { describe, expect, it } from 'vitest';
import type { TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import { runningPermissionMode } from '../mcp-tools/session-start-permission.js';
import { clampClaudeMode, gatePermissionMode, turnPermissionMode } from '../turn-permission.js';

const PLAN: TurnPermissionLevel = { asks: 'always', reach: 'read' };

describe('a conversation set to dontAsk', () => {
  it('runs a stranger’s turn at dontAsk, not at the default that asks', () => {
    expect(
      turnPermissionMode({ permissionMode: 'dontAsk', turnPermissionCeiling: 'runtime-default' })
    ).toBe('dontAsk');
  });

  it('answers the tool gate and session_start at dontAsk under the stranger ceiling', () => {
    const session = {
      permissionMode: 'dontAsk',
      turnPermissionCeiling: 'runtime-default' as const,
      backgroundPermissionCeiling: 'runtime-default' as const,
    };
    expect(gatePermissionMode(session)).toBe('dontAsk');
    expect(runningPermissionMode(session)).toBe('dontAsk');
  });

  it('is still held down by a ceiling stricter than the default, such as Plan', () => {
    expect(clampClaudeMode('dontAsk', PLAN)).toBe('plan');
  });

  it('changes nothing for the declared modes', () => {
    expect(clampClaudeMode('bypassPermissions', 'runtime-default')).toBe('default');
    expect(clampClaudeMode('made-up', 'runtime-default')).toBe('default');
  });
});
