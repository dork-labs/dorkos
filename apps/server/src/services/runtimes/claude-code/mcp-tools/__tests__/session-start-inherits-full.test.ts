/**
 * A chat at Full autonomy that starts a chat without naming a mode starts it at
 * Full (DOR-3147), within Security's exact scope (2026-10-20): only when the
 * caller's LIVE level is Full, the turn is unmarked, the caller is in a chat,
 * what a person set is known and not below Full, and the call raises no card.
 * Everything else keeps `NAME_FULL_AUTONOMY`, and an unmarked start never goes
 * above what a person set.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PermissionStop } from '@dorkos/shared/agent-runtime';
import {
  levelOfMode,
  resolveCeilingLevel,
  type DeclaredModes,
} from '@dorkos/shared/permission-semantics';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtime-constants.js';

vi.mock('../../../../core/runtime-registry.js', () => ({
  runtimeRegistry: {
    computerRuntimeForAgentPath: () => undefined,
    has: (type: string) => type === 'claude-code',
    get: () => ({ getCapabilities: () => CLAUDE_CODE_CAPABILITIES }),
    // A chat with no live mode whose stored row says Full.
    getSessionSettings: async (id: string) =>
      id === 'stored-full' ? { permissionMode: 'bypassPermissions' } : null,
  },
}));

const { resolveStartPermission } = await import('../session-start-permission.js');
type Facts = NonNullable<Parameters<typeof resolveStartPermission>[5]>;

const MODES = CLAUDE_CODE_CAPABILITIES.permissionModes as DeclaredModes;
const FULL = 'bypassPermissions';
const DEFAULT = MODES.default!;

/** Nothing set for the agent, and a call that raises no card. */
const PLAIN: Facts = { personSetStop: null, fullUnnamedAllowed: true };

/** A start from a Claude Code chat at `mode` (its live level, or `null` for none). */
const startFrom = (
  mode: string | null,
  opts: { marked?: boolean; requested?: string; facts?: Facts; sessionId?: string } = {}
) =>
  resolveStartPermission(
    opts.requested,
    { sessionId: opts.sessionId ?? 'caller', permissionMode: mode, runtime: 'claude-code' },
    'claude-code',
    null,
    opts.marked ?? false,
    'facts' in opts ? opts.facts : PLAIN
  );

/** The mode a start was granted, or the refusal code. */
async function grantedMode(result: ReturnType<typeof startFrom>): Promise<string> {
  const r = await result;
  return r.ok ? r.permission.mode : `refused:${r.code}`;
}

describe('a session_start from a chat at Full, with no mode named', () => {
  it('inherits Full in the plain case, and its turns raise no approval cards', async () => {
    const result = await startFrom(FULL);
    expect(result).toMatchObject({
      ok: true,
      permission: { mode: FULL, callerMode: FULL, sameAsCaller: true },
    });
    // A room turn the new chat wakes is held to its level as a ceiling. That
    // ceiling never asks, so a shell command there puts no card to a person.
    const level = levelOfMode(MODES, result.ok ? result.permission.mode : undefined);
    expect(level).toBeDefined();
    expect(resolveCeilingLevel(MODES, level!).asks).toBe('never');
  });

  it('is capped at the runtime default when the turn is marked, and Full named is refused', async () => {
    expect(await grantedMode(startFrom(FULL, { marked: true }))).toBe(DEFAULT);
    expect(await grantedMode(startFrom(FULL, { marked: true, requested: FULL }))).toBe(
      'refused:ABOVE_YOUR_LEVEL'
    );
  });

  it('is capped below a person-set level, named or not', async () => {
    const facts: Facts = { personSetStop: 'act', fullUnnamedAllowed: true };
    expect(await grantedMode(startFrom(FULL, { facts }))).toBe('acceptEdits');
    expect(await grantedMode(startFrom(FULL, { facts, requested: FULL }))).toBe(
      'refused:ABOVE_YOUR_LEVEL'
    );
    const ask: Facts = { personSetStop: 'ask' as PermissionStop, fullUnnamedAllowed: true };
    expect(await grantedMode(startFrom(FULL, { facts: ask }))).toBe(DEFAULT);
  });

  it('inherits Full when what a person set is Full', async () => {
    const facts: Facts = { personSetStop: 'autonomy', fullUnnamedAllowed: true };
    expect(await grantedMode(startFrom(FULL, { facts }))).toBe(FULL);
  });

  it('needs Full named when the call raises a card, or the agent is held', async () => {
    const facts: Facts = { personSetStop: null, fullUnnamedAllowed: false };
    expect(await grantedMode(startFrom(FULL, { facts }))).toBe('refused:NAME_FULL_AUTONOMY');
    expect(await grantedMode(startFrom(FULL, { facts, requested: FULL }))).toBe(FULL);
  });

  it('needs Full named when what a person set cannot be read, or no facts were read', async () => {
    const unknown: Facts = { personSetStop: 'unknown', fullUnnamedAllowed: true };
    expect(await grantedMode(startFrom(FULL, { facts: unknown }))).toBe(
      'refused:NAME_FULL_AUTONOMY'
    );
    expect(await grantedMode(startFrom(FULL, { facts: undefined }))).toBe(
      'refused:NAME_FULL_AUTONOMY'
    );
  });

  it('needs Full named when the level is a stored row, not the live one', async () => {
    expect(await grantedMode(startFrom(null, { sessionId: 'stored-full' }))).toBe(
      'refused:NAME_FULL_AUTONOMY'
    );
  });

  it('never inherits Full for a caller with no chat (the external server)', async () => {
    const result = await resolveStartPermission(
      undefined,
      null,
      'claude-code',
      'autonomy',
      false,
      PLAIN
    );
    expect(result.ok && result.permission.mode).not.toBe(FULL);
  });
});

describe('a session_start from below Full, or naming a mode', () => {
  it('passes a lower caller’s own level on', async () => {
    expect(await grantedMode(startFrom('acceptEdits'))).toBe('acceptEdits');
    expect(await grantedMode(startFrom('default'))).toBe('default');
    expect(await grantedMode(startFrom('plan'))).toBe('plan');
  });

  it('honors a named lower mode from a chat at Full', async () => {
    expect(await grantedMode(startFrom(FULL, { requested: 'acceptEdits' }))).toBe('acceptEdits');
    expect(await grantedMode(startFrom(FULL, { requested: 'default' }))).toBe('default');
  });

  it('refuses Full from a chat below it, named or not', async () => {
    expect(await grantedMode(startFrom('acceptEdits', { requested: FULL }))).toBe(
      'refused:ABOVE_YOUR_LEVEL'
    );
  });
});
