/**
 * A `session_start` refusal names what really held the level (DOR-3386): a chat held to
 * Default by a mark, a person's setting or a level DorkOS could not find no longer reads
 * "This chat runs at Default", which sent people and agents looking for a mode nobody set.
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

/** A start asking for Full from a Claude Code chat whose live mode is `mode`. */
const askFullFrom = (mode: string | null, marked: boolean, personSet?: 'ask') =>
  resolveStartPermission(
    FULL,
    { sessionId: 'caller', permissionMode: mode, runtime: 'claude-code' },
    'claude-code',
    null,
    marked,
    personSet ? { personSetStop: personSet, fullUnnamedAllowed: false } : undefined
  );

/** The refusal text of a start, or a failure when it was granted. */
async function refusalOf(result: ReturnType<typeof askFullFrom>): Promise<string> {
  const settled = await result;
  if (settled.ok) throw new Error('expected a refusal');
  expect(settled.code).toBe('ABOVE_YOUR_LEVEL');
  return settled.error;
}

describe('a session_start refusal says why the level is held', () => {
  it('names a mark, not the chat’s own level, for a Full chat that read others', async () => {
    const error = await refusalOf(askFullFrom(FULL, true));
    expect(error).toMatch(/read messages from others/);
    // Named the way the app names levels, not by the runtime's labels.
    expect(error).toMatch(/at Ask first at most, not Full autonomy/);
    expect(error).toMatch(/A person can start one at Full autonomy\./);
    expect(error).not.toMatch(/This chat runs at/);
  });

  it('names a person’s setting when that is what holds it', async () => {
    const error = await refusalOf(askFullFrom(FULL, false, 'ask'));
    // The cap can be a person's choice or the configured default, so it names neither alone.
    expect(error).toMatch(/This agent's level is Ask first \(set by a person, or the default\)/);
    expect(error).not.toMatch(/This chat runs at/);
  });

  it('says the level could not be found when there is no live or saved one', async () => {
    const error = await refusalOf(askFullFrom(null, false));
    expect(error).toMatch(/could not find this chat's level/);
    expect(error).not.toMatch(/This chat runs at/);
  });

  it('still says the chat runs at its own level when nothing else holds it', async () => {
    const error = await refusalOf(askFullFrom('acceptEdits', false));
    expect(error).toMatch(/^This chat runs at Accept edits, so it cannot start a chat at/);
  });
});
