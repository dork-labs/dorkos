/**
 * The one implementation of {@link RoomAttachmentStore} that exists today:
 * bytes on this machine, under the DorkOS data directory.
 *
 * Two things here are load-bearing rather than incidental. Both ids arrive from
 * a URL, so nothing either one contains may reach the filesystem as a path —
 * `..` and `/` are refused rather than sanitized, in the room position as well
 * as the attachment position. And the store never decides what a file is: it is
 * told the content type by the caller, because the only trustworthy answer to
 * that was settled at upload by the byte sniff.
 *
 * The filesystem isolation is structural: the store's constructor takes the
 * data directory and has no fallback, so a test that forgot to hand it a temp
 * dir would not compile — no `DORK_HOME` env var and no `vi.mock` of
 * `dork-home.ts` is needed or wanted.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, readFile, utimes, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { InvalidRoomAttachmentIdError } from '../room-attachment-store.js';
import { LocalRoomAttachmentStore } from '../local-room-attachment-store.js';

const BYTES = Buffer.from('the crash log, verbatim\n');
const OTHER_BYTES = Buffer.from('a different crash log\n');

async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('LocalRoomAttachmentStore', () => {
  let dorkHome: string;
  let store: LocalRoomAttachmentStore;

  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-room-attachments-'));
    store = new LocalRoomAttachmentStore(dorkHome);
  });

  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
  });

  it('writes under <dorkHome>/rooms/<roomId>/attachments and hands back a URL for it', async () => {
    const { url } = await store.put('room1', 'att1', 'log', BYTES);

    expect(await readdir(path.join(dorkHome, 'rooms', 'room1', 'attachments'))).toEqual([
      'att1.log',
    ]);
    expect(url).toBe('/api/rooms/room1/attachments/att1');
  });

  it('stores a file with no suffix under its bare id, with no trailing dot', async () => {
    await store.put('room1', 'att1', '', BYTES);

    expect(await readdir(path.join(dorkHome, 'rooms', 'room1', 'attachments'))).toEqual(['att1']);
  });

  it('round-trips the bytes with the type it was told and a weak ETag', async () => {
    await store.put('room1', 'att1', 'log', BYTES);
    const stored = await store.get('room1', 'att1', 'log', 'text/plain');

    expect(stored).not.toBeNull();
    // The store was TOLD this; it never sniffed the bytes on the way out.
    expect(stored?.contentType).toBe('text/plain');
    expect(stored?.size).toBe(BYTES.byteLength);
    // Weak, and derived from one `stat` — the bytes are streamed, never read
    // into memory to decide whether to send them.
    expect(stored?.etag).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);
    expect(await drain(stored!.stream)).toEqual(BYTES);
  });

  it('changes the ETag when the bytes change, so a replaced file is not a stale cache hit', async () => {
    await store.put('room1', 'att1', 'log', BYTES);
    const first = await store.get('room1', 'att1', 'log', 'text/plain');
    // A different LENGTH, so the validator moves even if the clock does not tick
    // between two writes in the same millisecond.
    await store.put('room1', 'att1', 'log', Buffer.concat([OTHER_BYTES, OTHER_BYTES]));
    const second = await store.get('room1', 'att1', 'log', 'text/plain');

    expect(second?.etag).not.toBe(first?.etag);
  });

  it('derives the validator from the file’s metadata, not from its content', async () => {
    // The property that replaced content hashing: the validator comes from one
    // `stat`, so a 304 costs no read at all. Asserted by moving the MTIME while
    // leaving the bytes identical — a content hash cannot see that, and this
    // must.
    await store.put('room1', 'att1', 'log', BYTES);
    const before = await store.get('room1', 'att1', 'log', 'text/plain');

    const file = (await store.localPath('room1', 'att1', 'log'))!;
    const later = new Date(Date.now() + 60_000);
    await utimes(file, later, later);
    const after = await store.get('room1', 'att1', 'log', 'text/plain');

    expect(await readFile(file)).toEqual(BYTES);
    expect(after?.etag).not.toBe(before?.etag);
  });

  it('hands the stream over unread, so a 304 pays for nothing', async () => {
    await store.put('room1', 'att1', 'log', BYTES);

    const stored = await store.get('room1', 'att1', 'log', 'text/plain');

    // Draining is the caller's choice; the conditional path destroys it instead.
    expect(stored?.stream.readableEnded).toBe(false);
    stored?.stream.destroy();
  });

  it('answers a real path from localPath, which really opens', async () => {
    await store.put('room1', 'att1', 'log', BYTES);
    const file = await store.localPath('room1', 'att1', 'log');

    expect(file).not.toBeNull();
    expect(path.isAbsolute(file!)).toBe(true);
    expect(await readFile(file!)).toEqual(BYTES);
  });

  it('answers null from localPath for a file that was never written', async () => {
    expect(await store.localPath('room1', 'nobody', 'log')).toBeNull();
  });

  it('answers null for an id that was never written', async () => {
    expect(await store.get('room1', 'nobody', 'log', 'text/plain')).toBeNull();
    expect(await store.get('nosuchroom', 'att1', 'log', 'text/plain')).toBeNull();
  });

  it('deletes one file, and deleting again is not an error', async () => {
    await store.put('room1', 'att1', 'log', BYTES);
    await store.delete('room1', 'att1', 'log');
    await store.delete('room1', 'att1', 'log');

    expect(await store.get('room1', 'att1', 'log', 'text/plain')).toBeNull();
    expect(await readdir(path.join(dorkHome, 'rooms', 'room1', 'attachments'))).toEqual([]);
  });

  it('leaves this room’s other files, and other rooms, alone', async () => {
    await store.put('room1', 'att1', 'log', BYTES);
    await store.put('room1', 'att2', 'log', OTHER_BYTES);
    await store.put('room2', 'att3', 'log', OTHER_BYTES);

    await store.delete('room1', 'att1', 'log');

    expect(await store.get('room1', 'att2', 'log', 'text/plain')).not.toBeNull();
    expect(await store.get('room2', 'att3', 'log', 'text/plain')).not.toBeNull();
  });

  it('treats an unusable id as nothing to delete rather than an error', async () => {
    // The same asymmetry `get` draws: the caller's intent — that file is not
    // here any more — is satisfied either way.
    await expect(store.delete('../escape', 'att1', 'log')).resolves.toBeUndefined();
    await expect(store.delete('room1', '../escape', 'log')).resolves.toBeUndefined();
  });

  it.each(['../escape', 'a/b', '..', '', '.', 'a\0b'])(
    'refuses a room id that is a path: %j',
    async (roomId) => {
      await expect(store.put(roomId, 'att1', 'log', BYTES)).rejects.toBeInstanceOf(
        InvalidRoomAttachmentIdError
      );
      expect(await store.get(roomId, 'att1', 'log', 'text/plain')).toBeNull();
      expect(await store.localPath(roomId, 'att1', 'log')).toBeNull();
    }
  );

  it.each(['../escape', 'a/b', '..', '', '.', 'a\0b'])(
    'refuses an attachment id that is a path: %j',
    async (attachmentId) => {
      await expect(store.put('room1', attachmentId, 'log', BYTES)).rejects.toBeInstanceOf(
        InvalidRoomAttachmentIdError
      );
      expect(await store.get('room1', attachmentId, 'log', 'text/plain')).toBeNull();
      expect(await store.localPath('room1', attachmentId, 'log')).toBeNull();
    }
  );

  it.each(['../escape', 'a/b', '.', 'a\0b', 'lo g'])(
    'refuses an extension that is a path: %j',
    async (extension) => {
      await expect(store.put('room1', 'att1', extension, BYTES)).rejects.toBeInstanceOf(
        InvalidRoomAttachmentIdError
      );
      expect(await store.get('room1', 'att1', extension, 'text/plain')).toBeNull();
      expect(await store.localPath('room1', 'att1', extension)).toBeNull();
    }
  );

  it('cannot be walked out of even when a file really is up there', async () => {
    const outside = path.join(dorkHome, 'secret.log');
    await writeFile(outside, BYTES);
    await mkdir(path.join(dorkHome, 'rooms', 'room1', 'attachments'), { recursive: true });

    expect(await store.get('room1', '../../secret', 'log', 'text/plain')).toBeNull();
    expect(await store.get('../..', 'secret', 'log', 'text/plain')).toBeNull();
    // And the file both were aiming at is untouched.
    expect(await readFile(outside)).toEqual(BYTES);
  });
});
