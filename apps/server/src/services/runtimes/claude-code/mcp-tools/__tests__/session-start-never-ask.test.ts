/**
 * `session_start` and Claude Code's "Never ask" mode (DOR-2838). An agent may not pick Never ask
 * for another chat, and a chat in it may only start chats that cannot ask either, so a refused
 * call can never come back to a person as an approval card through a chat it started. Each case
 * fails if the matching rule in `grantMode` is removed.
 */
import { describe, expect, it, vi } from 'vitest';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtime-constants.js';
import { CODEX_CAPABILITIES } from '../../../codex/runtime-constants.js';
import { OPENCODE_CAPABILITIES } from '../../../opencode/runtime-constants.js';

const CAPS = {
  'claude-code': CLAUDE_CODE_CAPABILITIES,
  codex: CODEX_CAPABILITIES,
  opencode: OPENCODE_CAPABILITIES,
} as const;

vi.mock('../../../../core/runtime-registry.js', () => ({
  runtimeRegistry: {
    has: (type: string) => type in CAPS,
    get: (type: keyof typeof CAPS) => ({ getCapabilities: () => CAPS[type] }),
    getSessionSettings: async () => null,
  },
}));

const { resolveStartPermission } = await import('../session-start-permission.js');

/** A start from a Claude Code chat running at `mode`. */
const start = (mode: string, requested: string | undefined, runtime = 'claude-code') =>
  resolveStartPermission(
    requested,
    { sessionId: 'caller', permissionMode: mode, runtime: 'claude-code' },
    runtime
  );

describe('an agent cannot pick Never ask', () => {
  it.each(['default', 'acceptEdits', 'bypassPermissions'])(
    'refuses it by name from a chat at %s',
    async (mode) => {
      expect(await start(mode, 'dontAsk')).toMatchObject({ ok: false, code: 'PERSON_ONLY_MODE' });
    }
  );

  it('refuses it by name from a caller with no chat', async () => {
    expect(await resolveStartPermission('dontAsk', null, 'claude-code')).toMatchObject({
      ok: false,
      code: 'PERSON_ONLY_MODE',
    });
  });
});

describe('a chat set to Never ask only starts chats that cannot ask', () => {
  it('passes Never ask on when no mode is named, or when it is named', async () => {
    expect(await start('dontAsk', undefined)).toMatchObject({
      ok: true,
      permission: { mode: 'dontAsk' },
    });
    expect(await start('dontAsk', 'dontAsk')).toMatchObject({
      ok: true,
      permission: { mode: 'dontAsk', sameAsCaller: true },
    });
  });

  it.each(['default', 'acceptEdits', 'auto', 'bypassPermissions'])(
    'refuses a chat at %s, which could ask',
    async (mode) => {
      expect(await start('dontAsk', mode)).toMatchObject({ ok: false });
    }
  );

  it('refuses Plan, which asks a person to approve its plan', async () => {
    expect(await start('dontAsk', 'plan')).toMatchObject({ ok: false });
  });

  it('starts Codex at its read-only sandbox, which has nothing to ask about', async () => {
    expect(await start('dontAsk', undefined, 'codex')).toMatchObject({
      ok: true,
      permission: { mode: 'default' },
    });
    expect(await start('dontAsk', 'acceptEdits', 'codex')).toMatchObject({ ok: false });
  });

  it('refuses OpenCode, whose every mode can ask', async () => {
    expect(await start('dontAsk', undefined, 'opencode')).toMatchObject({
      ok: false,
      code: 'NO_MODE_FITS',
    });
    expect(await start('dontAsk', 'default', 'opencode')).toMatchObject({ ok: false });
  });

  it('holds on a stranger’s turn too: the running mode stays Never ask', async () => {
    const { runningPermissionMode } = await import('../session-start-permission.js');
    const running = runningPermissionMode({
      permissionMode: 'dontAsk',
      turnPermissionCeiling: 'runtime-default',
    } as never);
    expect(running).toBe('dontAsk');
    expect(await start(running!, 'default')).toMatchObject({ ok: false });
  });
});

describe('a chat set to Never ask whose turn a stricter ceiling holds to Plan', () => {
  const heldToPlan = (requested: string | undefined) =>
    resolveStartPermission(
      requested,
      { sessionId: 'caller', permissionMode: 'plan', runtime: 'claude-code', neverAsks: true },
      'claude-code'
    );

  it('still starts nothing that can ask, Plan included', async () => {
    expect(await heldToPlan(undefined)).toMatchObject({ ok: false });
    expect(await heldToPlan('plan')).toMatchObject({ ok: false });
    expect(await heldToPlan('default')).toMatchObject({ ok: false });
  });

  it('cannot reach past Plan by naming Never ask', async () => {
    expect(await heldToPlan('dontAsk')).toMatchObject({ ok: false, code: 'ABOVE_YOUR_LEVEL' });
  });
});

describe('other chats are unchanged', () => {
  it('still start at their own level and inherit it', async () => {
    expect(await start('default', undefined)).toMatchObject({
      ok: true,
      permission: { mode: 'default' },
    });
    expect(await start('acceptEdits', 'default')).toMatchObject({
      ok: true,
      permission: { mode: 'default' },
    });
  });
});
