/**
 * The seam, asserted rather than promised.
 *
 * "Sync-ready" is only worth saying if something would break when it stopped
 * being true, so this file stands a store up that keeps nothing on this machine
 * — an absolute URL out of `put`, `null` out of `localPath` — and pins what the
 * rest of the system is then obliged to do with those two answers.
 *
 * The second block drives the REAL upload route over that store, which is the
 * half that makes the claim falsifiable: the URL has to survive from `put`
 * through the row, through the post, and out to a reader without anything in
 * between rebuilding it — and nothing may be written to this machine on the way.
 * The projector half ("a null `localPath` takes the fetch branch") lands here
 * too, with the agent projection.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtemp, rm, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { createTestDb } from '@dorkos/test-utils/db';
import type { RoomAttachmentStore } from '../room-attachment-store.js';
import type { AuthorRecord } from '../../author-registry.js';

/**
 * A store that keeps nothing locally and answers with an absolute URL — exactly
 * what a bucket-backed implementation would do.
 */
const cdn: RoomAttachmentStore = {
  put: async () => ({ url: 'https://cdn.example/x.bin' }),
  get: async () => null,
  localPath: async () => null,
  delete: async () => {},
};

describe('the RoomAttachmentStore seam', () => {
  it('is satisfied by a store that never touches this machine', async () => {
    // The compiler is doing the real work here: `cdn` is annotated with the
    // interface, so a method the port grew and a remote store could not answer
    // would fail this file before it ran.
    await expect(cdn.delete('room1', 'att1', 'bin')).resolves.toBeUndefined();
  });

  it('answers put with the absolute URL it chose, untouched by any path logic', async () => {
    const { url } = await cdn.put('room1', 'att1', 'bin', Buffer.from('x'));

    expect(url).toBe('https://cdn.example/x.bin');
  });

  it('answers null from localPath, the honest signal that the bytes are not here', async () => {
    expect(await cdn.localPath('room1', 'att1', 'bin')).toBeNull();
  });
});

/** Who the route thinks is calling. */
let caller: AuthorRecord;

vi.mock('../../../../routes/room-caller.js', () => ({
  resolveCaller: () => caller,
}));

vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) =>
      key === 'uploads' ? { maxFileSize: 4096, maxFiles: 3, allowedTypes: ['*/*'] } : undefined,
    getAll: () => ({}),
  },
}));

const { default: roomsRouter } = await import('../../../../routes/rooms.js');
const { createRoomSubsystem, setRoomService, setRoomAttachmentStores } =
  await import('../../index.js');
const { AttachmentRowStore } = await import('../attachment-row-store.js');

describe('the seam, through the real route', () => {
  let dorkHome: string;
  let app: express.Express;
  let roomId: string;

  beforeEach(async () => {
    // A directory that a LOCAL store would have written into. Nothing here
    // should ever create it.
    dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-seam-'));
    const db = createTestDb();
    const subsystem = createRoomSubsystem({
      db,
      agents: { byPath: () => null },
      turns: { run: async () => ({}) } as never,
    });
    setRoomService(subsystem.service);
    setRoomAttachmentStores({ attachments: cdn, rows: new AttachmentRowStore(db) });

    caller = subsystem.authors.localHuman();
    roomId = subsystem.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [] },
      caller.id
    ).id;

    app = express();
    app.use(express.json());
    app.use('/api/rooms', roomsRouter);
  });

  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
  });

  it('serves whatever URL the store returned, absolute host and all, all the way to a reader', async () => {
    const posted = await request(app)
      .post(`/api/rooms/${roomId}/attachments`)
      .attach('files', Buffer.from('bytes'), { filename: 'thing.bin' });

    // 1. The upload answers exactly what the store said.
    expect(posted.body.attachments[0].url).toBe('https://cdn.example/x.bin');

    // 2. The row kept it, rather than a path rebuilt from the ids.
    const wrote = await request(app)
      .post(`/api/rooms/${roomId}/entries`)
      .send({ text: 'from somewhere else', attachmentIds: [posted.body.attachments[0].id] });
    expect(wrote.status).toBe(202);

    // 3. And a reader gets it verbatim, with no route, schema or renderer
    //    change anywhere between the store and here.
    const listed = await request(app).get(`/api/rooms/${roomId}/entries?limit=10`);
    const entry = listed.body.entries.find((e: { id: string }) => e.id === wrote.body.entryId);
    expect(entry.attachments[0].url).toBe('https://cdn.example/x.bin');
  });

  it('writes nothing to this machine — the route never touched a path', async () => {
    await request(app)
      .post(`/api/rooms/${roomId}/attachments`)
      .attach('files', Buffer.from('bytes'), { filename: 'thing.bin' });

    // The assertion `profile-avatar.test.ts` makes for avatars: the directory a
    // local store would have created does not exist.
    await expect(readdir(path.join(dorkHome, 'rooms'))).rejects.toThrow();
  });
});
