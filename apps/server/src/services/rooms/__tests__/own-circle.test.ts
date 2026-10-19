/**
 * Marks, not levels, between the owner's own agents (DOR-3107, Security). In
 * the owner's own circle a post KNOWN to be unmarked hands on no ceiling but the
 * cap a person set on its poster; a post nobody kept marks for, a marked post,
 * and every room outside the circle stay as they were.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { RoomContextData } from '@dorkos/shared/additional-context';
import { setEntryMarksStore } from '../../core/turn-power/turn-levels.js';
import { createEntryMarksStore } from '../limits/entry-marks-store.js';
import { ceilingForEntry } from '../limits/turn-ceiling.js';
import { isOwnCircle, posterCapsFor } from '../limits/own-circle.js';
import { agentLookupFor, createRoomHarness, type RoomHarness } from './room-test-harness.js';

const OWN = { ownCircle: true } as const;
const ACT = { asks: 'when-risky', reach: 'workspace' } as const;

/** A room context showing these entries and nothing else. */
function shown(
  entries: Array<{ id: string; kind?: string; authorIsPerson?: boolean; authorOrigin?: string }>
): Pick<RoomContextData, 'pending' | 'gathered' | 'channelTail'> {
  return {
    pending: entries.map((e) => ({ kind: 'post', authorIsPerson: false, ...e })),
  } as unknown as Pick<RoomContextData, 'pending' | 'gathered' | 'channelTail'>;
}

describe('own-circle room turns', () => {
  let harness: RoomHarness;
  let channel: RoomWithRoster;
  let bo: string;

  beforeEach(() => {
    harness = createRoomHarness({
      agents: agentLookupFor({
        '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'mention-only' },
      }),
    });
    channel = harness.service.createRoom(
      { kind: 'channel', title: 'Team', members: [], agentPaths: ['/agents/bo'] },
      harness.human
    );
    bo = harness.authors.resolveAgent('/agents/bo', 'Bo').id;
    setEntryMarksStore(createEntryMarksStore(harness.db));
  });

  afterEach(() => setEntryMarksStore(null));

  /** A post by Bo whose level this process never kept, as after a restart. */
  function postByBo(marks?: Record<string, unknown>): { id: string; authorId: string } {
    const entry = harness.service.post(channel.id, { authorId: bo, text: 'checking the build' });
    if (marks) createEntryMarksStore(harness.db).write(channel.id, entry.id, marks);
    return entry;
  }

  // Security's test: an unmarked post read back after a restart wakes an agent
  // with no card.
  it('hands on no ceiling for a post known to be unmarked, read back after a restart', () => {
    const entry = postByBo({});
    expect(ceilingForEntry(harness.authors, entry, false, channel.id, OWN)).toEqual({});
  });

  it('holds it to the cap a person set on the poster', () => {
    const entry = postByBo({});
    const circle = { ownCircle: true, posterCap: () => ACT };
    expect(ceilingForEntry(harness.authors, entry, false, channel.id, circle)).toEqual({
      permissionCeiling: ACT,
    });
  });

  it('keeps a post nobody kept marks for at the default, in the circle too', () => {
    const entry = postByBo();
    expect(ceilingForEntry(harness.authors, entry, false, channel.id, OWN)).toEqual({
      permissionCeiling: 'runtime-default',
    });
  });

  it('keeps a marked post capped, in the circle too', () => {
    const entry = postByBo({ outsider: true });
    expect(ceilingForEntry(harness.authors, entry, false, channel.id, OWN)).toEqual({
      permissionCeiling: 'runtime-default',
    });
  });

  it('changes nothing outside the circle', () => {
    const entry = postByBo({});
    expect(ceilingForEntry(harness.authors, entry, false, channel.id)).toEqual({
      permissionCeiling: 'runtime-default',
    });
  });

  describe('isOwnCircle', () => {
    const plain = { inSpaceRoom: false, bridged: false };

    it('holds for a room of the owner and their own agents, with every post vouched for', () => {
      const entry = postByBo({});
      expect(isOwnCircle(shown([{ id: entry.id }]), channel.id, plain)).toBe(true);
    });

    it('fails in a space room or a bridged room', () => {
      const entry = postByBo({});
      const context = shown([{ id: entry.id }]);
      expect(isOwnCircle(context, channel.id, { inSpaceRoom: true, bridged: false })).toBe(false);
      expect(isOwnCircle(context, channel.id, { inSpaceRoom: false, bridged: true })).toBe(false);
    });

    it('fails with an outsider’s words in view', () => {
      const entry = postByBo({});
      const context = shown([{ id: entry.id }, { id: 'x', authorOrigin: 'external' }]);
      expect(isOwnCircle(context, channel.id, plain)).toBe(false);
    });

    it('fails with an agent post in view that nobody kept marks for', () => {
      const vouched = postByBo({});
      const unknown = postByBo();
      const context = shown([{ id: vouched.id }, { id: unknown.id }]);
      expect(isOwnCircle(context, channel.id, plain)).toBe(false);
    });

    it('ignores the owner’s own lines', () => {
      const entry = postByBo({});
      const context = shown([{ id: entry.id }, { id: 'p', authorIsPerson: true }]);
      expect(isOwnCircle(context, channel.id, plain)).toBe(true);
    });
  });

  it('reads each agent poster’s cap once, and none for a person', async () => {
    const entry = postByBo({});
    const read: string[] = [];
    const capOf = await posterCapsFor(
      harness.authors,
      [
        { ...entry, sessionId: 'bo-room-chat' },
        { ...entry, sessionId: 'bo-room-chat' },
        { authorId: harness.human },
      ],
      async (agentPath, sessionIds) => {
        read.push(`${agentPath} ${sessionIds.join(',')}`);
        return ACT;
      }
    );
    // Once per poster, with the conversation it wrote from, whose mode a person
    // may have set below the poster's own (review finding 2).
    expect(read).toEqual(['/agents/bo bo-room-chat']);
    expect(capOf(bo)).toEqual(ACT);
    expect(capOf(harness.human)).toBeUndefined();
  });
});
