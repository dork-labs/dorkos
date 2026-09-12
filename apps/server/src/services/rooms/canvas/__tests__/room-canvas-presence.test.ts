/**
 * Who is looking at a room's canvas: the two honest sources, and the four ways
 * the fact is kept from outliving itself (spec `room-canvas` §9.4, D13).
 *
 * Everything here runs against a REAL rooms subsystem over a real SQLite
 * database (`createRoomHarness`), because every property this file is about is a
 * property of the real thing: that a face is published exactly once per change,
 * that the same statement twice costs nothing, that the log never learns about
 * it, and that a reader who connects afterwards never does either.
 *
 * Seeded defects, each run red before the code stood:
 *
 * - Publishing on every `setViewing` rather than only on a change reddens "says
 *   it once".
 * - Publishing the clear unconditionally reddens "a turn that never read the
 *   canvas shows nothing", which is the etiquette rule E16a rests on.
 * - Writing the fact onto the document row reddens "nothing is written down".
 *
 * @module server/services/rooms/canvas/tests/room-canvas-presence
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { RoomEvent, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { AuthorRegistry } from '../../author-registry.js';
import { RoomError } from '../../room-errors.js';
import type { RoomService } from '../../room-service.js';
import type { RoomCanvasService } from '../room-canvas-service.js';
import type { RoomBroadcaster } from '../../room-stream.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
} from '../../__tests__/room-test-harness.js';
import { MAX_ROOM_CANVAS_DOCUMENTS } from '../room-canvas-service.js';

const ANA = '/agents/ana';

const agents = agentLookupFor({
  [ANA]: { name: 'ana', displayName: 'Ana', responseMode: 'always' },
});

/** A document with no natural identity, so two opens are two documents. */
const jsonContent = (label: string) => ({ type: 'json', data: { label }, title: label }) as const;

describe('who is looking at a room’s canvas', () => {
  let service: RoomService;
  let canvas: RoomCanvasService;
  let broadcaster: RoomBroadcaster;
  let authors: AuthorRegistry;
  let room: RoomWithRoster;
  let human: string;
  let ana: string;

  beforeEach(() => {
    ({ service, authors, human, broadcaster } = createRoomHarness({
      agents,
      runner: scriptedRunner(() => null),
    }));
    canvas = service.canvas;
    room = service.createRoom(
      { kind: 'channel', title: 'Release train', members: [], agentPaths: [ANA] },
      human
    );
    ana = authors.resolveAgent(ANA, 'Ana').id;
  });

  /** Every frame the room's live readers saw while `act` ran. */
  const frames = async (act: () => void): Promise<RoomEvent[]> => {
    const abort = new AbortController();
    const seen: RoomEvent[] = [];
    const reading = (async () => {
      for await (const event of broadcaster.subscribe(room.id, abort.signal)) seen.push(event);
    })();
    act();
    await new Promise((resolve) => setTimeout(resolve, 0));
    abort.abort();
    await reading;
    return seen;
  };

  /** Just the presence frames out of a burst. */
  const presence = (seen: RoomEvent[]) =>
    seen.filter((e) => e.type === 'signal' && e.signal === 'presence');

  it('says where somebody is looking, once', async () => {
    const doc = canvas.open(room.id, human, jsonContent('the plan'));
    const seen = await frames(() => canvas.setViewing(room.id, human, doc.id));

    expect(presence(seen)).toEqual([
      {
        type: 'signal',
        signal: 'presence',
        authorId: human,
        at: expect.any(String),
        documentId: doc.id,
      },
    ]);
  });

  it('says it once — restating the same document fans nothing out', async () => {
    const doc = canvas.open(room.id, human, jsonContent('the plan'));
    canvas.setViewing(room.id, human, doc.id);

    const seen = await frames(() => {
      canvas.setViewing(room.id, human, doc.id);
      canvas.setViewing(room.id, human, doc.id);
    });
    expect(presence(seen)).toEqual([]);
  });

  it('takes the face off when they look away, and only then', async () => {
    const doc = canvas.open(room.id, human, jsonContent('the plan'));
    canvas.setViewing(room.id, human, doc.id);

    const goodbye = await frames(() => canvas.setViewing(room.id, human, null));
    expect(presence(goodbye)).toEqual([
      { type: 'signal', signal: 'presence', authorId: human, at: expect.any(String) },
    ]);

    // A second departure is not a departure.
    const again = await frames(() => canvas.setViewing(room.id, human, null));
    expect(presence(again)).toEqual([]);
  });

  it('a turn that never read the canvas shows nothing when it ends', async () => {
    // The whole of E16a in one assertion: the room turn's terminal clears
    // unconditionally, and for an agent that never looked that must be silent.
    // Announcing an absence is still announcing.
    const seen = await frames(() => canvas.clearViewing(room.id, ana));
    expect(presence(seen)).toEqual([]);
  });

  it('an agent that read a document gets a face, and loses it when its turn ends', async () => {
    const doc = canvas.open(room.id, human, jsonContent('the failing test'));

    const read = await frames(() => canvas.noteAgentRead(room.id, ana, doc.id));
    expect(presence(read)).toMatchObject([{ authorId: ana, documentId: doc.id }]);

    const released = await frames(() => canvas.clearViewing(room.id, ana));
    expect(presence(released)).toMatchObject([{ authorId: ana }]);
    expect(presence(released)[0]).not.toHaveProperty('documentId');
  });

  it('takes every face off a document that is closed', async () => {
    const doc = canvas.open(room.id, human, jsonContent('the plan'));
    canvas.setViewing(room.id, human, doc.id);
    canvas.noteAgentRead(room.id, ana, doc.id);

    const seen = await frames(() => canvas.close(room.id, human, doc.id));
    // A tab that is gone cannot hold a face, and the pair left behind would make
    // the NEXT thing either of them looks at read as a move from a document
    // nobody can see.
    expect(
      presence(seen)
        .map((e) => e.type === 'signal' && e.authorId)
        .sort()
    ).toEqual([human, ana].sort());
  });

  it('takes every face off a document the ceiling drops', async () => {
    // Eviction is the other way a tab disappears, and it is the one nobody
    // pressed — so it is the one a hand-written close path would forget. The
    // entry left behind would make the NEXT thing that member looked at read as
    // a move from a document nobody can see.
    const doomed = canvas.open(room.id, human, { type: 'url', url: 'https://example.test/0' });
    canvas.setViewing(room.id, human, doomed.id);

    const seen = await frames(() => {
      for (let n = 1; n <= MAX_ROOM_CANVAS_DOCUMENTS; n += 1) {
        canvas.open(room.id, human, { type: 'url', url: `https://example.test/${n}` });
      }
    });

    // It really was dropped…
    expect(canvas.get(room.id, doomed.id)).toBeNull();
    // …and the face went with it, unprompted.
    expect(presence(seen)).toMatchObject([{ authorId: human }]);
    expect(presence(seen)[0]).not.toHaveProperty('documentId');
  });

  it('is written down nowhere, and reaches nobody who was not already listening', async () => {
    const doc = canvas.open(room.id, human, jsonContent('the plan'));
    canvas.setViewing(room.id, human, doc.id);

    // Not on the row: the table is durable state and this is not part of it.
    expect(JSON.stringify(canvas.get(room.id, doc.id))).not.toContain('presence');
    // Not in the log: a room's record is what somebody should be able to read
    // later, and "Ana was on tab 2" is not that.
    expect(service.listEntries(room.id, human, { limit: 50 })).toEqual([]);
    // And not replayed. A reader that connects now hears nothing at all —
    // signals carry no `seq`, so there is nothing for a resume to come back for.
    const late = await frames(() => {});
    expect(presence(late)).toEqual([]);
  });

  it('takes a face off when that member’s last stream ends', async () => {
    const doc = canvas.open(room.id, human, jsonContent('the plan'));
    // Two windows, one person. The first to close proves nothing.
    canvas.readerArrived(room.id, human);
    canvas.readerArrived(room.id, human);
    canvas.setViewing(room.id, human, doc.id);

    const stillHere = await frames(() => canvas.readerLeft(room.id, human));
    expect(presence(stillHere)).toEqual([]);

    // The last one is the departure. Nothing a browser does on its way out can
    // be relied on — a closed lid runs no cleanup — so this is the event that
    // has to be the one that clears it.
    const gone = await frames(() => canvas.readerLeft(room.id, human));
    expect(presence(gone)).toMatchObject([{ authorId: human }]);
    expect(presence(gone)[0]).not.toHaveProperty('documentId');
  });

  it('refuses a document this room does not hold', () => {
    // Otherwise a face could be painted onto a tab that does not exist, which is
    // a member asserting something about the table rather than about themselves.
    expect(() => canvas.setViewing(room.id, human, 'not-a-document')).toThrow(RoomError);
  });

  it('refuses somebody who is not in the room, exactly as a read does', () => {
    const stranger = authors.resolveAgent('/agents/nobody', 'Nobody').id;
    expect(() => canvas.setViewing(room.id, stranger, null)).toThrow(RoomError);
  });
});
