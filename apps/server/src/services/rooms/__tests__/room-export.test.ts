/**
 * Exporting a room as JSONL (DOR-1225).
 *
 * Driven through the REAL service, store, author registry, reaction store and
 * attachment rows — the export's whole claim is that it reproduces what the room
 * actually holds, and a fixture standing in for any of those would only prove
 * the fixture round-trips.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ROOM_EXPORT_FORMAT,
  RoomExportLineSchema,
  roomExportFilename,
  type RoomExportEntry,
  type RoomExportHeader,
  type RoomExportLine,
  type RoomExportSummary,
} from '@dorkos/shared/room-export-schemas';
import type { AuthorRegistry } from '../author-registry.js';
import type { AttachmentRowStore } from '../attachments/attachment-row-store.js';
import type { RoomService } from '../room-service.js';
import type { RoomStore } from '../room-store.js';
import { agentLookupFor, createRoomHarness, scriptedRunner } from './room-test-harness.js';

const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'mention-only' },
});

/** Split an export into its three parts, checking the shape of each line. */
function readExport(lines: Generator<RoomExportLine>): {
  header: RoomExportHeader;
  entries: RoomExportEntry[];
  summary: RoomExportSummary;
} {
  // Serialized and re-parsed exactly as the route writes it and a reader reads
  // it, so anything that survives only as a live object (a `Date`, a `Map`) is
  // caught here rather than in somebody's downloads folder.
  const parsed = [...lines].map((line) =>
    RoomExportLineSchema.parse(JSON.parse(JSON.stringify(line)))
  );
  const header = parsed[0];
  const summary = parsed[parsed.length - 1];
  if (header?.type !== 'room-export') throw new Error('the first line was not a header');
  if (summary?.type !== 'summary') throw new Error('the last line was not a summary');
  return {
    header,
    entries: parsed.slice(1, -1) as RoomExportEntry[],
    summary,
  };
}

describe('exporting a room', () => {
  let service: RoomService;
  let store: RoomStore;
  let authors: AuthorRegistry;
  let attachments: AttachmentRowStore;
  let human: string;
  let ana: string;
  let bo: string;
  let channelId: string;

  beforeEach(() => {
    ({ service, store, authors, attachments, human } = createRoomHarness({
      agents,
      // Nobody answers, so the log holds exactly what the test puts in it.
      runner: scriptedRunner(() => null),
    }));
    ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    bo = authors.resolveAgent('/agents/bo', 'Bo').id;
    channelId = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana', '/agents/bo'] },
      human
    ).id;
  });

  describe('what the file holds', () => {
    it('carries every entry, in seq order, wrapped in a header and a receipt', () => {
      for (let n = 1; n <= 25; n += 1) {
        service.post(channelId, { authorId: n % 2 === 0 ? ana : human, text: `line ${n}` });
      }

      const { header, entries, summary } = readExport(service.exportRoom(channelId, human));

      expect(header.format).toBe(ROOM_EXPORT_FORMAT);
      // Compared against the store's own read of the same room, so this fails if
      // the export drops an entry, reorders one, or invents one.
      expect(entries.map((entry) => entry.id)).toEqual(
        store.listEntriesAfter(channelId, 0).map((entry) => entry.id)
      );
      expect(entries.map((entry) => entry.seq)).toEqual(
        [...Array(25).keys()].map((index) => index + 1)
      );
      expect(entries.map((entry) => entry.text)).toEqual(
        [...Array(25).keys()].map((index) => `line ${index + 1}`)
      );
      expect(summary).toEqual({ type: 'summary', entryCount: 25, firstSeq: 1, lastSeq: 25 });
    });

    it('pages the log without losing an entry at a page boundary', () => {
      // Comfortably past the 500-entry page the service reads in, so a paging
      // bug shows up as a gap or a repeat rather than as nothing at all.
      //
      // Appended through the store rather than posted: what is under test is how
      // the export READS a long log, and eleven hundred trips through mention
      // resolution, the cascade guard and the dispatcher would make this the
      // slowest test in the domain while proving nothing extra about paging.
      for (let n = 1; n <= 1_100; n += 1) {
        const id = `entry-${n}`;
        store.appendEntry({
          roomId: channelId,
          id,
          authorId: human,
          kind: 'post',
          body: { text: `line ${n}` },
          mentions: [],
          sessionId: null,
          cascadeRoot: id,
          cascadeDepth: 0,
          parentEntryId: null,
          threadRootEntryId: null,
          createdAt: new Date().toISOString(),
        });
      }

      const { entries, summary } = readExport(service.exportRoom(channelId, human));

      expect(summary.entryCount).toBe(1_100);
      expect(new Set(entries.map((entry) => entry.seq)).size).toBe(1_100);
      expect(entries[499].seq).toBe(500);
      expect(entries[500].seq).toBe(501);
    });

    it('says an empty room is empty rather than saying nothing', () => {
      const { entries, summary } = readExport(service.exportRoom(channelId, human));

      expect(entries).toEqual([]);
      expect(summary).toEqual({ type: 'summary', entryCount: 0, firstSeq: null, lastSeq: null });
    });

    it('describes the room and its roster on the header line', () => {
      service.updateMembership(channelId, human, bo, 'mention-only');

      const { header } = readExport(service.exportRoom(channelId, human));

      expect(header.room).toMatchObject({ id: channelId, kind: 'channel', slug: 'backend' });
      expect(header.exportedBy.id).toBe(human);
      expect(header.dorkosVersion).toBeTruthy();
      expect(header.members.map((member) => member.author.displayName).sort()).toEqual([
        'Ana',
        'Bo',
        'You',
      ]);
      expect(header.members.find((member) => member.author.id === bo)?.responseMode).toBe(
        'mention-only'
      );
    });
  });

  describe('resolving who said what', () => {
    it('names the author, the people they addressed, and everyone who reacted', () => {
      authors.setHandle(human, 'dorian');
      service.post(channelId, { authorId: human, text: 'ping @ana' });
      const answered = service.post(channelId, { authorId: ana, text: 'here' });
      service.toggleReaction(channelId, answered.id, human, '🎉');
      service.toggleReaction(channelId, answered.id, bo, '🎉');

      const { entries } = readExport(service.exportRoom(channelId, human));

      expect(entries[0].author).toMatchObject({ id: human, kind: 'human', handle: 'dorian' });
      expect(entries[0].mentions).toEqual([
        expect.objectContaining({ id: ana, displayName: 'Ana' }),
      ]);
      expect(entries[1].author).toMatchObject({
        id: ana,
        kind: 'agent',
        displayName: 'Ana',
      });
      // An agent carries the stable reference a reader compares on; a person has
      // none, and the file must not invent one for them.
      expect(entries[1].author.agentRef).toEqual(expect.any(String));
      expect(entries[0].author.agentRef).toBeUndefined();
      expect(entries[1].reactions).toEqual([
        {
          emoji: '🎉',
          firstAt: expect.any(String),
          by: [
            expect.objectContaining({ id: human }),
            expect.objectContaining({ id: bo, displayName: 'Bo' }),
          ],
        },
      ]);
      expect(entries[0].reactions).toEqual([]);
    });

    it('keeps a thread reply beside the message it answers, with its relation intact', () => {
      const root = service.post(channelId, { authorId: human, text: 'the question' });
      const reply = service.post(channelId, {
        authorId: ana,
        text: 'the answer',
        replyTo: root.id,
      });
      const after = service.post(channelId, { authorId: human, text: 'back in the channel' });

      const { entries } = readExport(service.exportRoom(channelId, human));

      // The reply is IN the file — a timeline read would have dropped it — and
      // it sits in seq order between the two top-level messages.
      expect(entries.map((entry) => entry.id)).toEqual([root.id, reply.id, after.id]);
      expect(entries[1]).toMatchObject({
        parentEntryId: root.id,
        threadRootEntryId: root.id,
      });
      expect(entries[0].threadRootEntryId).toBeNull();
    });

    it('carries an attachment by reference, never as bytes', () => {
      attachments.create(
        {
          roomId: channelId,
          id: 'att-1',
          authorId: human,
          name: 'deploy.log',
          extension: 'log',
          mimeType: 'text/plain',
          size: 11,
          preview: null,
          url: `/api/rooms/${channelId}/attachments/att-1`,
        },
        '2026-08-15T10:00:00.000Z'
      );
      service.post(channelId, { authorId: human, text: 'here it is', attachmentIds: ['att-1'] });

      const { entries } = readExport(service.exportRoom(channelId, human));

      expect(entries[0].attachments).toEqual([
        {
          id: 'att-1',
          name: 'deploy.log',
          mimeType: 'text/plain',
          size: 11,
          preview: null,
          url: `/api/rooms/${channelId}/attachments/att-1`,
        },
      ]);
    });

    it("keeps a notice's code and who it was about", () => {
      service.postNotice(channelId, {
        notice: 'budget_reached',
        text: 'Ana has used up this room’s automatic replies for the hour.',
        subjectAuthorId: ana,
      });

      const { entries } = readExport(service.exportRoom(channelId, human));

      expect(entries[0].kind).toBe('notice');
      expect(entries[0].notice).toBe('budget_reached');
      expect(entries[0].subject).toMatchObject({ id: ana, displayName: 'Ana' });
    });
  });

  describe('who may export, and how much', () => {
    it('refuses a caller who is not a member exactly as it refuses a room that is not there', () => {
      const theirs = service.createRoom(
        { kind: 'channel', title: 'Private', members: [], agentPaths: ['/agents/bo'] },
        human
      );
      service.removeMember(theirs.id, human, human);

      const outsider = (): unknown => [...service.exportRoom(theirs.id, ana)];
      const missing = (): unknown => [...service.exportRoom('room_nope', ana)];

      expect(outsider).toThrow('No such room');
      expect(missing).toThrow('No such room');
    });

    it('gives an agent only what was said after it arrived', () => {
      const late = service.createRoom(
        { kind: 'channel', title: 'Late', members: [], agentPaths: [] },
        human
      );
      const before = service.post(late.id, { authorId: human, text: 'said before ana arrived' });
      service.addMember(late.id, human, { agentPath: '/agents/ana' });
      const after = service.post(late.id, { authorId: human, text: 'said after ana arrived' });

      const { header, entries } = readExport(service.exportRoom(late.id, ana));

      expect(header.scope).toEqual({ fromSeq: before.seq, joinFloorApplied: true });
      expect(entries.map((entry) => entry.id)).toEqual([after.id]);
    });

    it('gives the operator the whole room even when they joined it late', () => {
      // An agent opened a room by itself and talked in it; the operator joined
      // afterwards. Her membership therefore starts above the first entries,
      // which is the only shape in which the decision below can be seen at all.
      const anas = service.createRoom(
        { kind: 'channel', title: 'Ana thinking', members: [], agentPaths: [] },
        ana
      );
      const first = service.post(anas.id, { authorId: ana, text: 'before you joined' });
      service.addMember(anas.id, human, { authorId: human });
      const second = service.post(anas.id, { authorId: human, text: 'after you joined' });

      expect(store.getMember(anas.id, human)?.joinedSeq).toBe(first.seq);

      const { header, entries } = readExport(service.exportRoom(anas.id, human));

      // The exit path: an owner handed a copy of their own room with the first
      // months missing has not been given their data.
      expect(header.scope).toEqual({ fromSeq: 0, joinFloorApplied: false });
      expect(entries.map((entry) => entry.id)).toEqual([first.id, second.id]);
    });

    it('applies the floor to a second person, not only to agents', () => {
      const owned = createRoomHarness({ agents, ownerUserId: 'owner-1' });
      const owner = owned.authors.bindOwner('owner-1').id;
      const guest = owned.authors.human('guest-1').id;
      const room = owned.service.createRoom(
        { kind: 'channel', title: 'Shared', members: [], agentPaths: [] },
        owner
      );
      const before = owned.service.post(room.id, { authorId: owner, text: 'before the guest' });
      owned.service.addMember(room.id, owner, { authorId: guest });
      const after = owned.service.post(room.id, { authorId: owner, text: 'after the guest' });

      const theirs = readExport(owned.service.exportRoom(room.id, guest));
      const mine = readExport(owned.service.exportRoom(room.id, owner));

      expect(theirs.header.scope.joinFloorApplied).toBe(true);
      expect(theirs.entries.map((entry) => entry.id)).toEqual([after.id]);
      expect(mine.header.scope.joinFloorApplied).toBe(false);
      expect(mine.entries.map((entry) => entry.id)).toEqual([before.id, after.id]);
    });
  });

  describe('the filename', () => {
    it('names a channel by its slug and a DM by its id, both dated', () => {
      expect(roomExportFilename({ slug: 'backend', id: 'ROOM1' }, '2026-08-15T10:00:00.000Z')).toBe(
        'room-backend-2026-08-15.jsonl'
      );
      expect(roomExportFilename({ slug: null, id: 'ROOM1' }, '2026-08-15T10:00:00.000Z')).toBe(
        'room-ROOM1-2026-08-15.jsonl'
      );
    });
  });
});
