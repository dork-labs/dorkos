/**
 * A file on a local post that was delivered to a Community, and then deleted, removed or erased
 * there, stops being offered here: the redaction sync drops its row and its stored bytes, the
 * room's attachment route answers 404, and an open window is told the entry has no files left
 * (DOR-2549). Driven through the REAL attachment route and the real local file store.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { ulid } from 'ulidx';
import { createTestDb } from '@dorkos/test-utils/db';
import { communityOutbox, type Db } from '@dorkos/db';
import type { CommunityEntry, CommunityRef } from '@dorkos/shared/community-adapter';
import type { RoomEvent } from '@dorkos/shared/room-schemas';
import type { AuthorRecord } from '../../services/rooms/author-registry.js';

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

/** Who the route thinks is calling. */
let caller: AuthorRecord;

vi.mock('../room-caller.js', () => ({
  resolveCaller: () => caller,
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: () => undefined,
    getAll: () => ({}),
  },
}));

const { default: roomsRouter } = await import('../rooms.js');
const { createRoomSubsystem, setRoomService, setRoomAttachmentStores } =
  await import('../../services/rooms/index.js');
const { LocalRoomAttachmentStore } =
  await import('../../services/rooms/attachments/local-room-attachment-store.js');
const { AttachmentRowStore } =
  await import('../../services/rooms/attachments/attachment-row-store.js');
const { RemoteMirrorStore } = await import('../../services/communities/remote/mirror-store.js');
const { RemoteRedactionSync } =
  await import('../../services/communities/remote/remote-redaction-sync.js');
const { eventFanOut } = await import('../../services/core/event-fan-out.js');

const REF = 'remote_files' as CommunityRef;
const REMOTE_ROOM = 'general';

/** The Community's copy of the local post, as the redaction feed returns it now. */
function remoteNow(text: string, attachments: CommunityEntry['attachments'] = []) {
  return {
    entry: {
      community: REF,
      roomId: REMOTE_ROOM,
      id: 'remote-7',
      authorId: 'remote-agent',
      text,
      mentions: [],
      parentEntryId: null,
      threadRootEntryId: null,
      depth: 0,
      cursor: 'cursor-7' as CommunityEntry['cursor'],
      createdAt: '2026-09-29T00:00:00.000Z',
      attachments,
    },
    remoteSeq: 7,
    author: { memberId: 'remote-agent', displayName: 'Ana', kind: 'agent' as const },
  };
}

describe('a Community removal drops the local files of a delivered post', () => {
  let db: Db;
  let dorkHome: string;
  let store: InstanceType<typeof LocalRoomAttachmentStore>;
  let rows: InstanceType<typeof AttachmentRowStore>;
  let service: ReturnType<typeof createRoomSubsystem>['service'];
  let mirrors: InstanceType<typeof RemoteMirrorStore>;
  let human: AuthorRecord;
  let roomId: string;
  let pages: Array<{ items: unknown[]; nextCursor: string; hasMore: boolean }>;
  let published: RoomEvent[];
  let sync: InstanceType<typeof RemoteRedactionSync>;

  beforeEach(async () => {
    db = createTestDb();
    dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-redaction-files-'));
    store = new LocalRoomAttachmentStore(dorkHome);
    rows = new AttachmentRowStore(db);
    const subsystem = createRoomSubsystem({ db, turns: { run: async () => ({}) } as never });
    service = subsystem.service;
    setRoomService(service);
    setRoomAttachmentStores({ attachments: store, rows });
    human = subsystem.authors.localHuman();
    caller = human;
    mirrors = new RemoteMirrorStore(db, subsystem.store, subsystem.authors);
    roomId = mirrors.ensureRoom({
      communityRef: REF,
      remoteRoomId: REMOTE_ROOM,
      title: 'General',
      topic: null,
      ownerAuthorId: human.id,
      accessors: [],
      authorizedAt: '2026-09-29T00:00:00.000Z',
    }).id;
    pages = [];
    published = [];
    const publish = service.stream.publish.bind(service.stream);
    vi.spyOn(service.stream, 'publish').mockImplementation((room, event) => {
      published.push(event);
      publish(room, event);
    });
    sync = new RemoteRedactionSync({
      db,
      mirrors,
      readers: () => ({
        readRedactions: async () => {
          const next = pages.shift();
          if (!next) throw new Error('no page scripted');
          return next as never;
        },
      }),
      attachmentBytes: store,
      publishRevisions: (localRoomId, seqs) => service.publishEntryRevisions(localRoomId, seqs),
    });
    const app = express();
    app.use(express.json());
    app.use('/api/rooms', roomsRouter);
    fixtureTarget.mount(app);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dorkHome, { recursive: true, force: true });
  });

  /** Store a file and stage its row, the way the upload route does. */
  async function stage(name: string, bytes: Buffer): Promise<string> {
    const id = ulid();
    const extension = path.extname(name).slice(1);
    const { url } = await store.put(roomId, id, extension, bytes);
    rows.create(
      {
        roomId,
        id,
        authorId: human.id,
        name,
        extension,
        mimeType: 'application/octet-stream',
        size: bytes.length,
        preview: null,
        url,
      },
      new Date().toISOString()
    );
    return id;
  }

  /** Post with these files and record the post as delivered to the Community as `remote-7`. */
  function postDelivered(attachmentIds: string[]) {
    const posted = service.post(roomId, {
      authorId: human.id,
      text: 'zqxfilecanary the report',
      attachmentIds,
    });
    db.insert(communityOutbox)
      .values({
        id: 'outbox-1',
        communityRef: REF,
        remoteRoomId: REMOTE_ROOM,
        ownerAuthorId: human.id,
        localEntryId: posted.id,
        localParentEntryId: null,
        localAgentId: 'local-ana',
        attachmentIds: JSON.stringify(attachmentIds),
        idempotencyKey: 'key-1',
        state: 'confirmed',
        createdAt: '2026-09-29T00:00:00.000Z',
        expiresAt: '2026-09-29T00:05:00.000Z',
        remoteEntryId: 'remote-7',
        failure: null,
        attempts: 1,
        nextAttemptAt: '2026-09-29T00:00:00.000Z',
      })
      .run();
    return posted;
  }

  const fileOnDisk = (id: string, extension: string) =>
    path.join(dorkHome, 'rooms', roomId, 'attachments', `${id}.${extension}`);
  const exists = (file: string) =>
    stat(file).then(
      () => true,
      () => false
    );
  const target = { communityRef: REF, remoteRoomId: REMOTE_ROOM, ownerAuthorId: '' };

  // Purpose: a message removed on the Community takes its files with it here: the route answers
  // 404, the bytes are gone from disk, and the open window's revision carries no files. It fails
  // if the rows or the bytes are left behind, or the revision still lists the file.
  it('stops serving, and deletes, every file of a removed message', async () => {
    const report = await stage('report.txt', Buffer.from('zqxbytescanary secret'));
    const posted = postDelivered([report]);
    const before = await request(fixtureServer).get(`/api/rooms/${roomId}/attachments/${report}`);
    expect(before.status).toBe(200);

    pages.push({
      items: [remoteNow('This message was removed by the host.')],
      nextCursor: 'c1',
      hasMore: false,
    });
    await sync.sync({ ...target, ownerAuthorId: human.id }, {});

    const after = await request(fixtureServer).get(`/api/rooms/${roomId}/attachments/${report}`);
    expect(after.status).toBe(404);
    expect(await exists(fileOnDisk(report, 'txt'))).toBe(false);
    expect(rows.get(roomId, report)).toBeNull();
    const revision = published.find((event) => event.type === 'revision');
    expect(revision).toMatchObject({
      type: 'revision',
      entry: { id: posted.id, body: { text: 'This message was removed by the host.' } },
    });
    expect(revision?.type === 'revision' && revision.entry.attachments).toEqual([]);
  });

  // Purpose: a file the Community still has on the entry is never deleted: only the one that
  // was removed goes. It fails if every file of a rewritten entry is dropped.
  it('keeps a file the entry still has on the Community', async () => {
    const keep = await stage('keep.txt', Buffer.from('still here'));
    const gone = await stage('gone.txt', Buffer.from('zqxbytescanary removed'));
    postDelivered([keep, gone]);

    pages.push({
      items: [
        remoteNow('zqxfilecanary the report', [
          {
            id: 'remote-file-1',
            name: 'keep.txt',
            contentType: 'text/plain',
            byteSize: 'still here'.length,
            checksum: 'sum',
          },
        ]),
      ],
      nextCursor: 'c1',
      hasMore: false,
    });
    await sync.sync({ ...target, ownerAuthorId: human.id }, {});

    expect(
      (await request(fixtureServer).get(`/api/rooms/${roomId}/attachments/${keep}`)).status
    ).toBe(200);
    expect(await exists(fileOnDisk(keep, 'txt'))).toBe(true);
    expect(
      (await request(fixtureServer).get(`/api/rooms/${roomId}/attachments/${gone}`)).status
    ).toBe(404);
    expect(await exists(fileOnDisk(gone, 'txt'))).toBe(false);
  });

  // Purpose: the bytes go BEFORE the page is recorded, so a stop in between leaves no file on disk
  // with nothing pointing at it, and the next sync finishes the page. It fails if the bytes are
  // only deleted after the commit.
  it('deletes the bytes before recording the page, and finishes it on the next sync', async () => {
    const report = await stage('report.txt', Buffer.from('zqxbytescanary secret'));
    postDelivered([report]);
    const apply = vi.spyOn(mirrors, 'applyRedactions').mockImplementationOnce(() => {
      throw new Error('the process stopped here');
    });
    const page = {
      items: [remoteNow('This message was deleted.')],
      nextCursor: 'c1',
      hasMore: false,
    };
    pages.push(page);
    await sync.sync({ ...target, ownerAuthorId: human.id }, {});

    expect(await exists(fileOnDisk(report, 'txt'))).toBe(false);
    expect(mirrors.redactionCursor(REF, REMOTE_ROOM, human.id)?.cursor).toBeNull();
    // The row is still there for a moment, but it has nothing to serve.
    expect(
      (await request(fixtureServer).get(`/api/rooms/${roomId}/attachments/${report}`)).status
    ).toBe(404);

    apply.mockRestore();
    pages.push(page);
    await sync.sync({ ...target, ownerAuthorId: human.id }, {});
    expect(rows.get(roomId, report)).toBeNull();
    expect(mirrors.redactionCursor(REF, REMOTE_ROOM, human.id)?.cursor).toBe('c1');
  });

  // Purpose: a large sync tells the room list once per room, not once per page.
  it('announces a room once per sync however many pages changed it', async () => {
    const files = [await stage('a.txt', Buffer.from('a'))];
    postDelivered(files);
    const fanOut = vi.spyOn(eventFanOut, 'broadcast');
    pages.push(
      { items: [remoteNow('This message was deleted.')], nextCursor: 'c1', hasMore: true },
      { items: [remoteNow('This message was deleted!')], nextCursor: 'c2', hasMore: true },
      { items: [remoteNow('This message was erased.')], nextCursor: 'c3', hasMore: false }
    );
    await sync.sync({ ...target, ownerAuthorId: human.id }, {});

    const updates = fanOut.mock.calls.filter(([name]) => name === 'room_updated');
    expect(updates).toEqual([['room_updated', { roomId }]]);
    expect(published.filter((event) => event.type === 'revision')).toHaveLength(3);
  });
});
