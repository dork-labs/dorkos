/**
 * The note a person's change to an agent's level carries (DOR-3175): how many
 * existing chats meet the new level at their next turn, by the turn-start rules.
 */
import { describe, it, expect } from 'vitest';
import type { PermissionChange } from '@dorkos/shared/permissions';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { createLevelReachNote, type AgentChatRow } from '../level-reach-note.js';

const ANA = '/agents/ana';

/** A person's Files & commands change on Ana. */
function filesChange(after: 'ask' | 'act' | 'autonomy'): PermissionChange {
  return {
    target: { kind: 'agent', agentId: 'ana', agentPath: ANA, agentName: 'Ana' },
    key: { kind: 'files' },
    before: null,
    after,
  } as PermissionChange;
}

/** The note reader over these chats, with Ana's level at `levelMode`. */
function noteFor(chats: AgentChatRow[], levelMode: string, followers: string[] = []) {
  return createLevelReachNote({
    chatsOf: (agentPath) => (agentPath === ANA ? chats : []),
    modes: () => CLAUDE_CODE_CAPABILITIES.permissionModes,
    levelModeOf: async () => levelMode,
    mayRise: (sessionId) => followers.includes(sessionId),
  });
}

describe('the level-reach note (DOR-3175)', () => {
  it('counts the chats a cap holds down', async () => {
    const note = noteFor(
      [
        { sessionId: 'a', runtime: 'claude-code', permissionMode: 'bypassPermissions' },
        { sessionId: 'b', runtime: 'claude-code', permissionMode: 'acceptEdits' },
        { sessionId: 'c', runtime: 'claude-code', permissionMode: 'default' },
      ],
      'default'
    );
    expect(await note([filesChange('ask')])).toBe(
      '2 existing chats run at the new level from their next turn.'
    );
  });

  it('counts only the chats that follow their agent up', async () => {
    const note = noteFor(
      [
        { sessionId: 'follows', runtime: 'claude-code', permissionMode: 'default' },
        { sessionId: 'capped', runtime: 'claude-code', permissionMode: 'default' },
        { sessionId: 'plan', runtime: 'claude-code', permissionMode: 'plan' },
      ],
      'bypassPermissions',
      ['follows', 'plan']
    );
    expect(await note([filesChange('autonomy')])).toBe(
      '1 existing chat runs at the new level from its next turn.'
    );
  });

  it('says so when no chat changes, and says nothing for a change to no level', async () => {
    const note = noteFor([], 'default');
    expect(await note([filesChange('ask')])).toBe('No existing chats change.');
    expect(
      await note([
        {
          target: { kind: 'agent', agentId: 'ana', agentPath: ANA, agentName: 'Ana' },
          key: { kind: 'area', area: 'rooms' },
          before: null,
          after: 'ask',
        } as PermissionChange,
      ])
    ).toBeUndefined();
  });
});
