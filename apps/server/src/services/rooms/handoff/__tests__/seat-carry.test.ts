/**
 * A seat turn that re-reads the room (a hand-off, a spin-off's report) is held as a turn answering
 * the room's recent posts would be: a mini app's post among them counts as a stranger's
 * (DOR-4023), through the REAL room service, author registry and kept marks.
 */
import { describe, expect, it } from 'vitest';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { MINI_APP_REPLY_MARKS } from '../../../extensions/rooms/extension-room-threads.js';
import {
  agentLookupFor,
  createRoomHarness,
  outcomeRunner,
} from '../../__tests__/room-test-harness.js';
import type { RoomCore } from '../../service/room-core.js';
import { withRoomMarks } from '../seat-carry.js';

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
