/**
 * Attaching files to a room message, driven through the REAL service, the REAL
 * store and the REAL trigger dispatcher.
 *
 * Three claims are under test and none of them is about the bytes, which live
 * behind a separate seam and never reach this layer:
 *
 * 1. **Binding is atomic with the message.** A file belongs to the entry that
 *    carries it or to nothing, and a failure part-way leaves neither.
 * 2. **A file may be posted once, by the person who uploaded it, in the room it
 *    was uploaded into.** Everything else is refused, and two of the refusals
 *    deliberately answer the same way so existence is never leaked.
 * 3. **Every path that hands an entry to a reader carries its attachments.**
 *    That is asserted across all three at once, because the failure mode is a
 *    path somebody forgot rather than a path somebody broke.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Db } from '@dorkos/db';
import { roomAttachments } from '@dorkos/db';
import type { RoomEvent, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { AuthorRegistry } from '../author-registry.js';
import type { AttachmentRowStore } from '../attachments/attachment-row-store.js';
import { RoomError } from '../room-errors.js';
import type { RoomService } from '../room-service.js';
import type { RoomStore } from '../room-store.js';
import { agentLookupFor, createRoomHarness, scriptedRunner } from './room-test-harness.js';

const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
});

/**
 * The configured file limit for these tests.
 *
 * Deliberately NOT the shipped default of 10 and nowhere near the schema's
 * static `ROOM_ATTACHMENT_MAX_PER_ENTRY` ceiling of 50, so a service that read
 * the wrong one of the two cannot coincidentally pass.
 */
const MAX_FILES = 3;

describe('room attachments', () => {
  let db: Db;
  let service: RoomService;
  let store: RoomStore;
  let attachments: AttachmentRowStore;
  let authors: AuthorRegistry;
  let room: RoomWithRoster;
  let human: string;
  let ana: string;
  let published: RoomEvent[] = [];
  let uploaded = 0;

  beforeEach(() => {
    ({ db, service, store, attachments, authors, human } = createRoomHarness({
      agents,
      // Silent: these tests measure what a post carries, and an agent answering
      // every message would fill the log with entries nobody here is asserting.
      runner: scriptedRunner(() => null),
      maxAttachmentsPerEntry: MAX_FILES,
    }));
    room = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana'] },
      human
    );
    ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    uploaded = 0;

    published = [];
    const broadcaster = service.stream;
    const deliver = broadcaster.publish.bind(broadcaster);
    vi.spyOn(broadcaster, 'publish').mockImplementation((roomId, event) => {
      if (roomId === room.id) published.push(event);
      deliver(roomId, event);
    });
  });

  /**
   * Stage one uploaded-but-unposted file, the way the upload route would.
   *
   * @param overrides.roomId - Which room it was uploaded into.
   * @param overrides.authorId - Who uploaded it.
   * @param overrides.name - The stored filename.
   */
  function upload(overrides: { roomId?: string; authorId?: string; name?: string } = {}): string {
    const id = `att-${(uploaded += 1)}`;
    const roomId = overrides.roomId ?? room.id;
    attachments.create(
      {
        roomId,
        id,
        authorId: overrides.authorId ?? human,
        name: overrides.name ?? `${id}.log`,
        extension: 'log',
        mimeType: 'text/plain',
        size: 11,
        preview: null,
        url: `/api/rooms/${roomId}/attachments/${id}`,
      },
      // Ordered, so the roll-up's upload-order claim is testable rather than
      // dependent on two rows landing in different milliseconds.
      `2026-08-08T10:0${uploaded}:00.000Z`
    );
    return id;
  }

  /** The live `entry` frames this room fanned out, in order. */
  function entryFrames(): Array<Extract<RoomEvent, { type: 'entry' }>> {
    return published.filter((event) => event.type === 'entry');
  }

  /** What the `room_attachments` row says this file is bound to. */
  function boundEntryOf(attachmentId: string): string | null {
    return (
      (
        db.$client
          .prepare('SELECT entry_id FROM room_attachments WHERE id = ?')
          .get(attachmentId) as { entry_id: string | null } | undefined
      )?.entry_id ?? null
    );
  }

  describe('binding', () => {
    it('binds every named file to the entry that carries it', () => {
      const first = upload();
      const second = upload();

      const entry = service.post(room.id, {
        authorId: human,
        text: 'here is what broke',
        attachmentIds: [first, second],
      });

      expect(boundEntryOf(first)).toBe(entry.id);
      expect(boundEntryOf(second)).toBe(entry.id);
    });

    it('writes NOTHING when the bind fails — no entry, no bound row', () => {
      const file = upload();
      const before = store.maxSeq(room.id);
      // A failure on the far side of the insert, which is the case the whole
      // `bind` hook exists for: the entry row is already written when this
      // throws, so a non-atomic implementation would leave it behind.
      vi.spyOn(attachments, 'bind').mockImplementation(() => {
        throw new Error('the row store refused');
      });

      expect(() =>
        service.post(room.id, { authorId: human, text: 'nope', attachmentIds: [file] })
      ).toThrow('the row store refused');

      expect(store.maxSeq(room.id), 'the entry rolled back with the bind').toBe(before);
      expect(boundEntryOf(file)).toBeNull();
      expect(entryFrames(), 'and nothing was published for a message that never landed').toEqual(
        []
      );
    });

    it('refuses to commit an entry when a file was claimed mid-write', () => {
      const file = upload();
      const before = store.maxSeq(room.id);
      // The race resolution cannot see: the id passed `resolveAttachments`, and
      // another post binds it in the instant before this one's own bind runs.
      // The UPDATE then matches nothing, and an entry that committed anyway
      // would reference a file belonging to somebody else's message — a state
      // the foreign key cannot catch, because the row it points at is perfectly
      // valid, just not this entry's.
      vi.spyOn(attachments, 'bind').mockReturnValue(0);

      expect(() =>
        service.post(room.id, { authorId: human, text: 'mine', attachmentIds: [file] })
      ).toThrow(expect.objectContaining({ code: 'ATTACHMENT_ALREADY_POSTED' }));

      // Rolled back whole: no entry, and nothing published.
      expect(store.maxSeq(room.id)).toBe(before);
      expect(entryFrames()).toEqual([]);
    });

    it('leaves a post with no attachments completely alone', () => {
      const entry = service.post(room.id, { authorId: human, text: 'just words' });

      expect(entry.id).toBeTruthy();
      expect(
        db.$client.prepare('SELECT COUNT(*) AS n FROM room_attachments').get() as { n: number }
      ).toEqual({ n: 0 });
    });
  });

  describe('what may be posted', () => {
    it('refuses a file that is already on another message', () => {
      const file = upload();
      service.post(room.id, { authorId: human, text: 'first', attachmentIds: [file] });

      expect(() =>
        service.post(room.id, { authorId: human, text: 'again', attachmentIds: [file] })
      ).toThrow(expect.objectContaining({ code: 'ATTACHMENT_ALREADY_POSTED' }));
    });

    it('refuses a file from another room', () => {
      const other = service.createRoom(
        { kind: 'channel', title: 'Other', members: [], agentPaths: [] },
        human
      );
      const elsewhere = upload({ roomId: other.id });

      expect(() =>
        service.post(room.id, { authorId: human, text: 'sneaky', attachmentIds: [elsewhere] })
      ).toThrow(expect.objectContaining({ code: 'ATTACHMENT_NOT_FOUND' }));
    });

    it('refuses somebody else’s unposted file, with the same answer a missing one gets', () => {
      const theirs = upload({ authorId: ana });

      // NOT a 403: telling this caller the file exists but is not theirs would
      // confirm a stranger's staging area one id at a time.
      expect(() =>
        service.post(room.id, { authorId: human, text: 'mine now', attachmentIds: [theirs] })
      ).toThrow(expect.objectContaining({ code: 'ATTACHMENT_NOT_FOUND' }));
    });

    it('refuses an id that never existed', () => {
      expect(() =>
        service.post(room.id, { authorId: human, text: 'ghost', attachmentIds: ['att-nope'] })
      ).toThrow(expect.objectContaining({ code: 'ATTACHMENT_NOT_FOUND' }));
    });

    it('refuses more files than the CONFIGURED limit allows', () => {
      const files = Array.from({ length: MAX_FILES + 1 }, () => upload());

      // The configured limit is 3 here and the schema's static ceiling is 50, so
      // a service reading the wrong one would accept these four.
      expect(() =>
        service.post(room.id, { authorId: human, text: 'all of them', attachmentIds: files })
      ).toThrow(expect.objectContaining({ code: 'TOO_MANY_ATTACHMENTS' }));
      // And it refused BEFORE writing: the room is still empty.
      expect(store.maxSeq(room.id)).toBe(0);
    });

    it('accepts exactly the configured limit', () => {
      const files = Array.from({ length: MAX_FILES }, () => upload());

      const entry = service.post(room.id, {
        authorId: human,
        text: 'right at the line',
        attachmentIds: files,
      });

      expect(files.every((id) => boundEntryOf(id) === entry.id)).toBe(true);
    });

    it('refuses the same file named twice in one message', () => {
      const file = upload();

      expect(() =>
        service.post(room.id, { authorId: human, text: 'twice', attachmentIds: [file, file] })
      ).toThrow(expect.objectContaining({ code: 'TOO_MANY_ATTACHMENTS' }));
    });

    it('refuses before writing anything at all', () => {
      const good = upload();

      expect(() =>
        service.post(room.id, {
          authorId: human,
          text: 'one good one bad',
          attachmentIds: [good, 'att-nope'],
        })
      ).toThrow(RoomError);

      expect(store.maxSeq(room.id), 'nothing was written').toBe(0);
      expect(boundEntryOf(good), 'and the good one is still unposted').toBeNull();
    });
  });

  describe('the roll-up', () => {
    it('carries the same files, in the same order, to every reader on every path', () => {
      const first = upload({ name: 'crash.log' });
      const second = upload({ name: 'trace.txt' });

      const entry = service.post(room.id, {
        authorId: human,
        text: 'both of these',
        attachmentIds: [first, second],
      });

      // 1. The history page.
      const listed = service.listEntries(room.id, human, { limit: 50 });
      // 2. The hydration snapshot, which also serves the resume replay.
      const hydrated = service.snapshot(room.id, human, 50);
      // 3. The live frame, captured off the broadcaster as it was published.
      const live = entryFrames().find((frame) => frame.entry.id === entry.id);

      const expected = [
        expect.objectContaining({ id: first, name: 'crash.log' }),
        expect.objectContaining({ id: second, name: 'trace.txt' }),
      ];
      // Asserted as ONE test over three sources on purpose: the failure this
      // catches is a path nobody updated, and three separate tests would let
      // two pass while the third was simply never written.
      expect(listed.find((e) => e.id === entry.id)?.attachments).toEqual(expected);
      expect(hydrated.entries.find((e) => e.id === entry.id)?.attachments).toEqual(expected);
      expect(live?.entry.attachments).toEqual(expected);
    });

    it('gives an entry with no files an empty list, never a missing one', () => {
      const entry = service.post(room.id, { authorId: human, text: 'just words' });

      expect(service.listEntries(room.id, human, { limit: 50 })[0].attachments).toEqual([]);
      expect(service.snapshot(room.id, human, 50).entries[0].attachments).toEqual([]);
      expect(entryFrames().find((f) => f.entry.id === entry.id)?.entry.attachments).toEqual([]);
    });

    it('carries a file’s stored URL verbatim rather than rebuilding it', () => {
      const file = upload();
      // What a bucket-backed store would have answered from `put`.
      db.update(roomAttachments).set({ url: 'https://cdn.example/x.bin' }).run();

      const entry = service.post(room.id, {
        authorId: human,
        text: 'from somewhere else',
        attachmentIds: [file],
      });

      expect(service.listEntries(room.id, human, { limit: 50 })[0].attachments?.[0].url).toBe(
        'https://cdn.example/x.bin'
      );
      expect(entryFrames().find((f) => f.entry.id === entry.id)?.entry.attachments?.[0].url).toBe(
        'https://cdn.example/x.bin'
      );
    });

    it('reaches a thread reply too, which is the same write path', () => {
      const root = service.post(room.id, { authorId: human, text: 'the thread' });
      const file = upload();

      const reply = service.post(room.id, {
        authorId: human,
        text: 'with a file',
        replyTo: root.id,
        attachmentIds: [file],
      });

      expect(boundEntryOf(file)).toBe(reply.id);
      expect(entryFrames().find((f) => f.entry.id === reply.id)?.entry.attachments).toEqual([
        expect.objectContaining({ id: file }),
      ]);
    });
  });
});
