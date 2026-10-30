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

describe('in a space’s local copy', () => {
  // Review should-fix 3: fail closed. Nothing but a vouch or this machine keeps the owner's power.
  it('reads every author nobody vouched for as a teammate, unresolvable ones included', () => {
    const { registry, member, telegram } = authors();
    expect(isTeammateEntry(registry, { id: 'gone-2', authorId: 'no-such-author' }, true)).toBe(
      true
    );
    expect(isTeammateEntry(registry, { id: 'tg-3', authorId: telegram }, true)).toBe(true);
    expect(isTeammateEntry(registry, { id: 'space-4', authorId: member }, true)).toBe(true);
    expect(
      ceilingForEntries(registry, [{ id: 'gone-3', authorId: 'no-such-author' }], true, 'space-r')
    ).toEqual({
      permissionCeiling: [
        'runtime-default',
        { ...READ_ONLY_LEVEL, teammate: [{ roomId: 'space-r', authorId: 'no-such-author' }] },
      ],
    });
  });

  it('keeps a person or an agent on this machine, and a vouched post, out of it', () => {
    const { registry, human, member } = authors();
    vouchOwnerSpaceEntry('space-owner-2');
    expect(isTeammateEntry(registry, { id: 'local-4', authorId: human }, true)).toBe(false);
    expect(isTeammateEntry(registry, { id: 'space-owner-2', authorId: member }, true)).toBe(false);
  });
});

describe('a teammate’s ceiling', () => {
  it('is a stranger’s and read access, both at once', () => {
    const { registry, member, telegram } = authors();
    // The read-access bound carries the teammate's mark: the room they wrote in and who they are.
    expect(ceilingForEntries(registry, [{ id: 'space-3', authorId: member }], false, 'r')).toEqual({
      permissionCeiling: [
        'runtime-default',
        { ...READ_ONLY_LEVEL, teammate: [{ roomId: 'r', authorId: member }] },
      ],
    });
    // A stranger from a bridged chat bounds nothing (DOR-3440).
    expect(ceilingForEntries(registry, [{ id: 'tg-2', authorId: telegram }])).toEqual({});
  });
});
