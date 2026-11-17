/**
 * A seat turn that re-reads the room (a hand-off, a spin-off's report) is held as a turn answering
 * the room's recent posts would be: a mini app's post among them counts as a stranger's
 * (DOR-4023), through the REAL room service, author registry and kept marks.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { MINI_APP_REPLY_MARKS } from '../../../extensions/rooms/extension-room-threads.js';
import {
  agentLookupFor,
  createRoomHarness,
  outcomeRunner,
} from '../../__tests__/room-test-harness.js';
import type { RoomCore } from '../../service/room-core.js';
import { env } from '../../../../env.js';
import { joinCeilings, withRoomMarks } from '../seat-carry.js';

function roomWith(marked: boolean) {
  const { service, human, authors } = createRoomHarness({
    agents: agentLookupFor({}),
    runner: outcomeRunner(() => ({ text: null })),
  });
  const room = service.createRoom(
    { kind: 'channel', title: 'Backend', members: [], agentPaths: [] },
    human
  );
  const posted = service.post(
    room.id,
    { authorId: human, text: 'take birch off Linear' },
    false,
    marked ? { marks: MINI_APP_REPLY_MARKS } : undefined
  ) as RoomEntry;
  const core = {
    store: { listEntries: () => [posted] },
    triggers: { deps: { isSpaceRoom: () => false } },
    authors,
    // The harness's person is the owner; the stranger mark (on by default, DOR-4453) asks.
    isOwnerAuthor: (id: string) => id === human,
  } as unknown as RoomCore;
  return { core, room, posted };
}

describe('withRoomMarks', () => {
  it('carries a mini app’s recent post into the seat as a stranger’s words', () => {
    const { core, room, posted } = roomWith(true);
    expect(
      withRoomMarks(core, 'seat-agent', { externalAuthor: false }, room, posted)
    ).toMatchObject({ externalAuthor: true });
  });

  it('carries a person’s own recent post as nothing', () => {
    const { core, room, posted } = roomWith(false);
    expect(
      withRoomMarks(core, 'seat-agent', { externalAuthor: false }, room, posted)
    ).toMatchObject({ externalAuthor: false });
  });
});

// DOR-4587 (Security S2): the seat's outsider mark comes from the post's own record, so it holds
// with stranger marking switched off, and only for the room the post is in.
describe('withRoomMarks with stranger marking off', () => {
  const flags = env as { DORKOS_MARK_STRANGER_TURNS: boolean };
  const saved = flags.DORKOS_MARK_STRANGER_TURNS;
  afterEach(() => {
    flags.DORKOS_MARK_STRANGER_TURNS = saved;
  });

  it('marks the seat turn for a mini app’s recent post', () => {
    flags.DORKOS_MARK_STRANGER_TURNS = false;
    const { core, room, posted } = roomWith(true);
    expect(
      withRoomMarks(core, 'seat-agent', { externalAuthor: false }, room, posted)
    ).toMatchObject({ outsider: true });
  });

  it('leaves the seat turn unmarked for a person’s own post', () => {
    flags.DORKOS_MARK_STRANGER_TURNS = false;
    const { core, room, posted } = roomWith(false);
    expect(
      withRoomMarks(core, 'seat-agent', { externalAuthor: false }, room, posted).outsider
    ).toBeUndefined();
  });
});

// The shared join retains records, not merely the computed effective power axes.
describe('joinCeilings', () => {
  it('keeps a teammate origin and every prior/current bound without mutating the inputs', () => {
    const teammate = {
      asks: 'never',
      reach: 'everything',
      teammate: [{ roomId: 'room-fixture', authorId: 'member-fixture' }],
    } as const;
    const level = { asks: 'always', reach: 'read' } as const;
    const current = { asks: 'always', reach: 'edit', outsider: true } as const;
    expect(joinCeilings(joinCeilings(teammate, level), current)).toEqual([
      teammate,
      level,
      current,
    ]);
    expect(joinCeilings(undefined, undefined)).toBeUndefined();
    expect(joinCeilings(teammate, undefined)).toBe(teammate);
  });
});
