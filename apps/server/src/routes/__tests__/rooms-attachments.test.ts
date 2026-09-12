/**
 * `POST/GET /api/rooms/:id/attachments` over HTTP.
 *
 * Four things are pinned here, and "the file round-trips" is only the first.
 *
 * The second is that **what a file IS is decided by its bytes**: a `.png` full
 * of markup stores with no preview and comes back as an octet-stream
 * attachment, never as a document the browser will render on this app's own
 * origin — and a `.png` full of GIF is served as the GIF it is rather than as
 * the PNG it claimed. That one line is the whole safety property of this
 * feature, and the mutation it survives is written down beside it.
 *
 * The third is that **an agent is refused before its bytes are read** — asserted
 * by the absence of a directory rather than by the status code alone, because a
 * 403 returned after multer has already spooled the upload is not the refusal
 * this route promises.
 *
 * The fourth is that **existence is never leaked**: a stranger's unposted file,
 * a file from another room and a file that never existed all answer 404.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { mkdtemp, rm, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { AuthorRecord } from '../../services/rooms/author-registry.js';
import { captureUncaughtExceptions } from './uncaught-exceptions.js';

/**
 * Lets one file vanish between the store's `stat` and the `createReadStream`
 * that follows it — the window a delete or the retention sweep really opens,
 * made deterministic. Everything else passes straight through to the real
 * filesystem.
 */
const fsControl = vi.hoisted(() => ({ deleteAfterNextStat: false }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const stat = async (...args: Parameters<typeof actual.stat>) => {
    const info = await actual.stat(...args);
    if (fsControl.deleteAfterNextStat) {
      fsControl.deleteAfterNextStat = false;
      await actual.rm(args[0] as string, { force: true });
    }
    return info;
  };
  // Both import forms route through the override. Spreading the untouched
  // `actual` as `default` would leave `fsp.stat(...)` on the real filesystem,
  // and this seam would go silently vacuous the day a store switched to a
  // default import — a test that cannot fail rather than a test that failed.
  return { ...actual, stat, default: { ...actual, stat } };
});

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

/** Who the route thinks is calling. Swapped per test. */
let caller: AuthorRecord;

vi.mock('../room-caller.js', () => ({
  resolveCaller: () => caller,
}));

/** The `uploads` block the route builds multer from. Mutable per test. */
let uploadConfig = { maxFileSize: 1024, maxFiles: 3, allowedTypes: ['*/*'] as string[] };

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'uploads' ? uploadConfig : undefined),
    getAll: () => ({ uploads: uploadConfig }),
  },
}));

const { default: roomsRouter } = await import('../rooms.js');
const { createRoomSubsystem, setRoomService, setRoomAttachmentStores } =
  await import('../../services/rooms/index.js');
const { LocalRoomAttachmentStore } =
  await import('../../services/rooms/attachments/local-room-attachment-store.js');
const { AttachmentRowStore } =
  await import('../../services/rooms/attachments/attachment-row-store.js');
const { agentLookupFor } = await import('../../services/rooms/__tests__/room-test-harness.js');

/** A real 1×1 PNG — the smallest thing that genuinely is the format. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
/** GIF bytes. Uploaded as `.png`, announced as `image/png` — and neither is evidence. */
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(32, 3)]);
const TEXT = Buffer.from('the crash log, verbatim\n');

const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
});

describe('/api/rooms/:id/attachments', () => {
  let db: Db;
  let dorkHome: string;
  let store: InstanceType<typeof LocalRoomAttachmentStore>;
  let rows: InstanceType<typeof AttachmentRowStore>;
  let app: express.Express;
  let roomId: string;
  let human: AuthorRecord;
  let ana: AuthorRecord;
  let service: ReturnType<typeof createRoomSubsystem>['service'];
  let authors: ReturnType<typeof createRoomSubsystem>['authors'];

  beforeEach(async () => {
    fsControl.deleteAfterNextStat = false;
    uploadConfig = { maxFileSize: 1024, maxFiles: 3, allowedTypes: ['*/*'] };
    db = createTestDb();
    dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-room-attachments-route-'));
    store = new LocalRoomAttachmentStore(dorkHome);
    rows = new AttachmentRowStore(db);

    const subsystem = createRoomSubsystem({
      db,
      agents,
      turns: { run: async () => ({}) } as never,
    });
    service = subsystem.service;
    authors = subsystem.authors;
    setRoomService(service);
    setRoomAttachmentStores({ attachments: store, rows });

    human = authors.localHuman();
    ana = authors.resolveAgent('/agents/ana', 'Ana');
    caller = human;

    const room = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana'] },
      human.id
    );
    roomId = room.id;

    app = express();
    app.use(express.json());
    app.use('/api/rooms', roomsRouter);

    fixtureTarget.mount(app);
  });

  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
  });

  /** Where this room's bytes would land, if any did. */
  function attachmentDir(): string {
    return path.join(dorkHome, 'rooms', roomId, 'attachments');
  }

  /** Upload one file as the current caller. */
  function upload(bytes: Buffer, filename: string, contentType?: string) {
    const req = request(fixtureServer).post(`/api/rooms/${roomId}/attachments`);
    return req.attach('files', bytes, { filename, contentType });
  }

  describe('who may upload', () => {
    it('refuses an agent before a single byte is read', async () => {
      caller = ana;

      const res = await upload(TEXT, 'notes.log');

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PEOPLE_ONLY');
      // THE assertion that makes this about ordering rather than about status
      // codes: multer never ran, so there is no directory at all.
      await expect(readdir(attachmentDir())).rejects.toThrow();
    });

    it('refuses a non-member with the same 404 a missing room gets', async () => {
      const other = authors.human('someone-else');
      caller = other;

      const res = await upload(TEXT, 'notes.log');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ROOM_NOT_FOUND');
      await expect(readdir(attachmentDir())).rejects.toThrow();
    });

    it('refuses an archived room', async () => {
      service.updateRoom(roomId, human.id, { archived: true });

      const res = await upload(TEXT, 'notes.log');

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ROOM_ARCHIVED');
    });
  });

  describe('limits', () => {
    it('accepts a file of exactly the configured size', async () => {
      const res = await upload(Buffer.alloc(uploadConfig.maxFileSize, 7), 'big.bin');

      expect(res.status).toBe(200);
      expect(res.body.attachments[0].size).toBe(uploadConfig.maxFileSize);
    });

    it('refuses one byte more, with the configured figure in the message', async () => {
      const res = await upload(Buffer.alloc(uploadConfig.maxFileSize + 1, 7), 'big.bin');

      expect(res.status).toBe(413);
      expect(res.body.error).toContain(`${uploadConfig.maxFileSize / 1024 / 1024}MB`);
    });

    it('refuses a type outside the configured allowlist', async () => {
      uploadConfig = { ...uploadConfig, allowedTypes: ['image/png'] };

      const res = await upload(TEXT, 'notes.log', 'text/plain');

      expect(res.status).toBe(415);
    });

    it('refuses a request with no files at all', async () => {
      const res = await request(fixtureServer).post(`/api/rooms/${roomId}/attachments`);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('ATTACHMENT_MISSING');
    });

    it('leaves nothing behind when one file of several fails', async () => {
      // The caller gets no ids back, so anything that survived here could never
      // be referenced by any message — a permanent orphan minted by the error
      // path itself.
      const realPut = store.put.bind(store);
      let puts = 0;
      vi.spyOn(store, 'put').mockImplementation(async (room, id, extension, bytes) => {
        puts += 1;
        if (puts === 2) throw new Error('disk is on fire');
        return realPut(room, id, extension, bytes);
      });

      const res = await request(fixtureServer)
        .post(`/api/rooms/${roomId}/attachments`)
        .attach('files', TEXT, { filename: 'one.log' })
        .attach('files', TEXT, { filename: 'two.log' });

      expect(res.status).toBe(500);
      // The first file's bytes AND its row are both gone.
      await expect(readdir(attachmentDir())).resolves.toEqual([]);
      expect(rows.listUnboundFor(roomId, [])).toEqual([]);
      expect(db.$client.prepare('SELECT COUNT(*) AS n FROM room_attachments').get()).toEqual({
        n: 0,
      });
    });
  });

  describe('what a file is judged to be', () => {
    it('stores a real PNG as a previewable image and serves it inline', async () => {
      const posted = await upload(PNG, 'shot.png');
      expect(posted.status).toBe(200);
      expect(posted.body.attachments[0]).toMatchObject({
        name: 'shot.png',
        mimeType: 'image/png',
        preview: 'image',
      });

      const got = await request(fixtureServer).get(posted.body.attachments[0].url);

      expect(got.status).toBe(200);
      expect(got.headers['content-type']).toContain('image/png');
      expect(got.headers['content-disposition']).toBe('inline');
      expect(got.headers['x-content-type-options']).toBe('nosniff');
    });

    it('serves GIF bytes wearing a .png name as the GIF they are', async () => {
      const posted = await upload(GIF, 'sneaky.png', 'image/png');

      // Neither the filename nor the declared Content-Type is evidence. GIF is a
      // previewable raster type since an agent's recording became one (spec
      // `canvas-agent-seat` §3), so these bytes DO preview — but as what they
      // are, never as what they claimed. Setting `mimeType` from
      // `file.mimetype` turns this red: it would serve a GIF as `image/png`.
      expect(posted.body.attachments[0].preview).toBe('image');
      expect(posted.body.attachments[0].mimeType).toBe('image/gif');

      const got = await request(fixtureServer).get(posted.body.attachments[0].url);

      expect(got.headers['content-type']).toContain('image/gif');
      expect(got.headers['x-content-type-options']).toBe('nosniff');
    });

    it('refuses to preview bytes that are no image at all, however they are dressed', async () => {
      // The half the case above no longer covers, and the one that carries the
      // safety property: a file announced as an image, named as an image, and
      // full of markup is an attachment. Setting `preview` from
      // `file.mimetype.startsWith('image/')` turns this red — witnessed, and it
      // is the mutation this pair exists for.
      const posted = await upload(
        Buffer.from('<html><script>alert(1)</script></html>'),
        'sneaky.png',
        'image/png'
      );

      expect(posted.body.attachments[0].preview).toBeNull();

      const got = await request(fixtureServer).get(posted.body.attachments[0].url);

      expect(got.headers['content-type']).toContain('application/octet-stream');
      expect(got.headers['content-disposition']).toBe('attachment; filename="sneaky.png"');
    });

    it('serves an ordinary file as a download, never as a document', async () => {
      const posted = await upload(
        Buffer.from('<html><script>alert(1)</script></html>'),
        'page.html',
        'text/html'
      );

      const got = await request(fixtureServer).get(posted.body.attachments[0].url);

      expect(posted.body.attachments[0].preview).toBeNull();
      expect(got.headers['content-type']).toContain('application/octet-stream');
      expect(got.headers['content-disposition']).toContain('attachment');
    });

    it('sanitizes the stored filename', async () => {
      const posted = await upload(TEXT, 'weird name;rm -rf.log');

      expect(posted.body.attachments[0].name).toBe('weird_name_rm_-rf.log');
    });
  });

  describe('serving', () => {
    it('round-trips the bytes', async () => {
      const posted = await upload(TEXT, 'crash.log');

      const got = await request(fixtureServer).get(posted.body.attachments[0].url);

      expect(got.status).toBe(200);
      expect(Buffer.from(got.body)).toEqual(TEXT);
      expect(got.headers['content-length']).toBe(String(TEXT.byteLength));
    });

    it('answers 304 with no body when the ETag still matches', async () => {
      const posted = await upload(TEXT, 'crash.log');
      const first = await request(fixtureServer).get(posted.body.attachments[0].url);

      const again = await request(fixtureServer)
        .get(posted.body.attachments[0].url)
        .set('If-None-Match', first.headers.etag);

      expect(again.status).toBe(304);
      // No bytes on the wire — the point of the 304, and what proves the stream
      // was discarded rather than piped.
      expect(Buffer.from(again.body).byteLength).toBe(0);
    });

    it('survives the file being deleted while it is answering a 304', async () => {
      const posted = await upload(TEXT, 'crash.log');
      const first = await request(fixtureServer).get(posted.body.attachments[0].url);
      // A delete or the retention sweep landing between the `stat` that produced
      // the validator and the `fs.open` the returned stream submitted. The 304
      // path never reads that stream, and `destroy()` does not cancel an open
      // already in flight, so the ENOENT arrives with nobody listening — a
      // process-level uncaught exception that takes the server down on a
      // conditional GET (DOR-1831).
      fsControl.deleteAfterNextStat = true;

      const capture = captureUncaughtExceptions();
      try {
        const again = await request(fixtureServer)
          .get(posted.body.attachments[0].url)
          .set('If-None-Match', first.headers.etag);
        expect(again.status).toBe(304);
        await capture.settle();
      } finally {
        capture.stop();
      }

      expect(capture.errors).toEqual([]);
    });

    it('lets the uploader read their own unposted file', async () => {
      const posted = await upload(TEXT, 'crash.log');

      expect((await request(fixtureServer).get(posted.body.attachments[0].url)).status).toBe(200);
    });

    it('hides an unposted file from everybody else', async () => {
      const posted = await upload(TEXT, 'crash.log');
      // A member of the room — and still not entitled to somebody else's
      // staging area, which nobody may enumerate.
      caller = ana;

      const res = await request(fixtureServer).get(posted.body.attachments[0].url);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ATTACHMENT_NOT_FOUND');
    });

    it('shows a POSTED file to anyone who may read the message', async () => {
      const posted = await upload(TEXT, 'crash.log');
      await request(fixtureServer)
        .post(`/api/rooms/${roomId}/entries`)
        .send({ text: 'here it is', attachmentIds: [posted.body.attachments[0].id] });

      caller = ana;
      const res = await request(fixtureServer).get(posted.body.attachments[0].url);

      expect(res.status).toBe(200);
    });

    it('hides a POSTED file from somebody who cannot see the room', async () => {
      const posted = await upload(TEXT, 'crash.log');
      await request(fixtureServer)
        .post(`/api/rooms/${roomId}/entries`)
        .send({ text: 'here it is', attachmentIds: [posted.body.attachments[0].id] });

      // A person, not an agent, and not on this room's roster. Being posted
      // makes a file readable by anyone who may read the MESSAGE — which is not
      // the same as everyone, and this is the half of that rule the sibling test
      // above cannot see: with the room check removed it still passes.
      caller = authors.human('someone-else');
      const res = await request(fixtureServer).get(posted.body.attachments[0].url);

      // 404 rather than 403: a stranger learns nothing, not even that the file
      // is real.
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ATTACHMENT_NOT_FOUND');
    });

    it('404s a file that never existed', async () => {
      const res = await request(fixtureServer).get(`/api/rooms/${roomId}/attachments/nope`);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ATTACHMENT_NOT_FOUND');
    });

    // A bare `..` is deliberately NOT in this table. Every HTTP client resolves
    // dot segments before sending, so `/attachments/..` leaves as
    // `/api/rooms/<id>/` and is answered by `GET /:id` — it never reaches this
    // handler, and asserting a status for it would be measuring Express's
    // routing table rather than this route's id guard. The percent-encoded
    // forms below are the ones that survive normalization and arrive here
    // decoded, which is exactly the shape the store's allowlist has to refuse.
    it.each(['..%2Fsecret', '%2e%2e%2f%2e%2e%2fetc%2fpasswd', '..%2f..%2fsecret'])(
      'cannot be walked out of the room with %s',
      async (id) => {
        const res = await request(fixtureServer).get(`/api/rooms/${roomId}/attachments/${id}`);

        expect(res.status).toBe(404);
        expect(res.body.code).toBe('ATTACHMENT_NOT_FOUND');
      }
    );
  });

  describe('posting what was uploaded', () => {
    it('carries the uploaded files onto the message', async () => {
      const posted = await upload(PNG, 'shot.png');
      const id = posted.body.attachments[0].id;

      const wrote = await request(fixtureServer)
        .post(`/api/rooms/${roomId}/entries`)
        .send({ text: 'look at this', attachmentIds: [id] });
      expect(wrote.status).toBe(202);

      const listed = await request(fixtureServer).get(`/api/rooms/${roomId}/entries?limit=10`);
      const entry = listed.body.entries.find((e: { id: string }) => e.id === wrote.body.entryId);
      expect(entry.attachments).toEqual([
        expect.objectContaining({ id, name: 'shot.png', preview: 'image' }),
      ]);
    });

    it('refuses a second message naming the same file', async () => {
      const posted = await upload(TEXT, 'crash.log');
      const id = posted.body.attachments[0].id;
      await request(fixtureServer)
        .post(`/api/rooms/${roomId}/entries`)
        .send({ text: 'first', attachmentIds: [id] });

      const again = await request(fixtureServer)
        .post(`/api/rooms/${roomId}/entries`)
        .send({ text: 'again', attachmentIds: [id] });

      expect(again.status).toBe(409);
      expect(again.body.code).toBe('ATTACHMENT_ALREADY_POSTED');
    });

    it('refuses more files than the configured limit', async () => {
      const ids: string[] = [];
      for (let n = 0; n <= uploadConfig.maxFiles; n += 1) {
        const posted = await upload(TEXT, `f${n}.log`);
        ids.push(posted.body.attachments[0].id);
      }

      const wrote = await request(fixtureServer)
        .post(`/api/rooms/${roomId}/entries`)
        .send({ text: 'all of them', attachmentIds: ids });

      expect(wrote.status).toBe(400);
      expect(wrote.body.code).toBe('TOO_MANY_ATTACHMENTS');
    });
  });
});
