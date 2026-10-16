/**
 * Which messages a teammate wrote (DOR-2955): a space member's, unless the space bridge vouched
 * for it as the owner's own. Nobody else is a teammate, and the turn a teammate's message starts
 * is held to a stranger's ceiling and read access together.
 */
import { READ_ONLY_LEVEL } from '@dorkos/shared/permission-semantics';
import { describe, expect, it } from 'vitest';
import { isTeammateEntry, teammateOf, vouchOwnerSpaceEntry } from '../limits/space-teammates.js';
import { ceilingForEntries } from '../limits/turn-ceiling.js';
import { agentLookupFor, createRoomHarness } from './room-test-harness.js';

function authors() {
  const harness = createRoomHarness({ agents: agentLookupFor({}) });
  const member = harness.authors.resolveExternal({
    platformType: 'community',
    instanceId: 'remote_team_space',
    platformUserId: 'remote-bo',
    displayName: 'Bo',
  });
  const telegram = harness.authors.resolveExternal({
    platformType: 'telegram',
    instanceId: 'bot-1',
    platformUserId: '42',
    displayName: 'Tg',
  });
  return {
    registry: harness.authors,
    human: harness.human,
    member: member.id,
    telegram: telegram.id,
  };
}

describe('isTeammateEntry', () => {
  it('reads a space member’s message as a teammate’s', () => {
    const { registry, member } = authors();
    expect(isTeammateEntry(registry, { id: 'space-1', authorId: member })).toBe(true);
    expect(teammateOf(registry, [{ id: 'space-1', authorId: member }])).toEqual({ teammate: true });
  });

  it('does not once the bridge vouched for it as the owner’s own', () => {
    const { registry, member } = authors();
    vouchOwnerSpaceEntry('space-owner-1');
    expect(isTeammateEntry(registry, { id: 'space-owner-1', authorId: member })).toBe(false);
  });

  it('never reads a person here, or a bridged chat, as a teammate', () => {
    const { registry, human, telegram } = authors();
    expect(isTeammateEntry(registry, { id: 'local-1', authorId: human })).toBe(false);
    expect(isTeammateEntry(registry, { id: 'tg-1', authorId: telegram })).toBe(false);
    expect(isTeammateEntry(registry, { id: 'gone-1', authorId: 'no-such-author' })).toBe(false);
  });

  it('marks a turn a teammate’s when ANY message it answers is one', () => {
    const { registry, human, member } = authors();
    expect(
      teammateOf(registry, [
        { id: 'local-2', authorId: human },
        { id: 'space-2', authorId: member },
      ])
    ).toEqual({ teammate: true });
    expect(teammateOf(registry, [{ id: 'local-3', authorId: human }])).toEqual({});
  });
});

describe('a teammate’s ceiling', () => {
  it('is a stranger’s and read access, both at once', () => {
    const { registry, member, telegram } = authors();
    expect(ceilingForEntries(registry, [{ id: 'space-3', authorId: member }])).toEqual({
      permissionCeiling: ['runtime-default', READ_ONLY_LEVEL],
    });
    // A stranger from a bridged chat keeps exactly what it had.
    expect(ceilingForEntries(registry, [{ id: 'tg-2', authorId: telegram }])).toEqual({
      permissionCeiling: 'runtime-default',
    });
  });
});
