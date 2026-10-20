/**
 * A chat at Full autonomy that starts a chat without naming a mode starts it at
 * Full (DOR-3147). Before, it was refused until the mode was named, so agents
 * named a lower one, and every room turn those chats woke asked a person again.
 * Everything else holds: a marked turn is capped, a lower caller passes on its
 * own level, a named lower mode is honored, and a caller with no chat is held to
 * its own stop.
 */
import { describe, expect, it, vi } from 'vitest';
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
    getSessionSettings: async () => null,
  },
}));

const { resolveStartPermission } = await import('../session-start-permission.js');

const MODES = CLAUDE_CODE_CAPABILITIES.permissionModes as DeclaredModes;
const FULL = 'bypassPermissions';
const DEFAULT = MODES.default!;

/** A start from a Claude Code chat at `mode`. */
const startFrom = (mode: string, opts: { marked?: boolean; requested?: string } = {}) =>
  resolveStartPermission(
    opts.requested,
    { sessionId: 'caller', permissionMode: mode, runtime: 'claude-code' },
    'claude-code',
    null,
    opts.marked ?? false
  );

/** The mode a start was granted, or the refusal code. */
async function grantedMode(result: ReturnType<typeof startFrom>): Promise<string> {
  const r = await result;
  return r.ok ? r.permission.mode : `refused:${r.code}`;
}

describe('a session_start with no mode named', () => {
  it('from an unmarked chat at Full, starts at Full, whose turns raise no approval cards', async () => {
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

  it('from a marked chat at Full, is still capped at the runtime default', async () => {
    expect(await grantedMode(startFrom(FULL, { marked: true }))).toBe(DEFAULT);
  });

  it('from a chat below Full, starts at that chat’s own level', async () => {
    expect(await grantedMode(startFrom('acceptEdits'))).toBe('acceptEdits');
    expect(await grantedMode(startFrom('default'))).toBe('default');
    expect(await grantedMode(startFrom('plan'))).toBe('plan');
  });

  it('from a caller with no chat, keeps it at its stop and never inherits Full', async () => {
    const result = await resolveStartPermission(undefined, null, 'claude-code', 'autonomy');
    expect(result.ok && result.permission.mode).not.toBe(FULL);
  });
});

describe('a session_start that names a mode', () => {
  it('from a chat at Full, honors a lower mode', async () => {
    expect(await grantedMode(startFrom(FULL, { requested: 'acceptEdits' }))).toBe('acceptEdits');
    expect(await grantedMode(startFrom(FULL, { requested: 'default' }))).toBe('default');
  });

  it('from a chat below Full, still refuses Full', async () => {
    expect(await grantedMode(startFrom('acceptEdits', { requested: FULL }))).toBe(
      'refused:ABOVE_YOUR_LEVEL'
    );
  });
});
