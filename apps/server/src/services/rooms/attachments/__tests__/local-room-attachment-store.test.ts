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
import { createHash } from 'crypto';
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { InvalidRoomAttachmentIdError } from '../room-attachment-store.js';
import { LocalRoomAttachmentStore } from '../local-room-attachment-store.js';

const BYTES = Buffer.from('the crash log, verbatim\n');
const OTHER_BYTES = Buffer.from('a different crash log\n');

/** What the ETag is asserted against — the store's hash, computed independently. */
function shortHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

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

  it('round-trips the bytes with the type it was told and a strong ETag', async () => {
    await store.put('room1', 'att1', 'log', BYTES);
    const stored = await store.get('room1', 'att1', 'log', 'text/plain');

    expect(stored).not.toBeNull();
    // The store was TOLD this; it never sniffed the bytes on the way out.
    expect(stored?.contentType).toBe('text/plain');
    expect(stored?.size).toBe(BYTES.byteLength);
    expect(stored?.etag).toBe(`"${shortHash(BYTES)}"`);
    expect(await drain(stored!.stream)).toEqual(BYTES);
  });

  it('changes the ETag when the bytes change, so a replaced file is not a stale cache hit', async () => {
    await store.put('room1', 'att1', 'log', BYTES);
    const first = await store.get('room1', 'att1', 'log', 'text/plain');
    await store.put('room1', 'att1', 'log', OTHER_BYTES);
    const second = await store.get('room1', 'att1', 'log', 'text/plain');

    expect(second?.etag).not.toBe(first?.etag);
    expect(second?.etag).toBe(`"${shortHash(OTHER_BYTES)}"`);
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

  it('deletes a room’s files, and deleting again is not an error', async () => {
    await store.put('room1', 'att1', 'log', BYTES);
    await store.deleteRoom('room1');
    await store.deleteRoom('room1');

    expect(await store.get('room1', 'att1', 'log', 'text/plain')).toBeNull();
    // The attachment directory itself is gone, not merely emptied — the room's
    // own directory is not this store's to remove.
    await expect(readdir(path.join(dorkHome, 'rooms', 'room1', 'attachments'))).rejects.toThrow();
  });

  it('leaves another room alone when one is cleared', async () => {
    await store.put('room1', 'att1', 'log', BYTES);
    await store.put('room2', 'att2', 'log', OTHER_BYTES);
    await store.deleteRoom('room1');

    expect(await store.get('room2', 'att2', 'log', 'text/plain')).not.toBeNull();
  });

  it.each(['../escape', 'a/b', '..', '', '.', 'a\0b'])(
    'refuses a room id that is a path: %j',
    async (roomId) => {
      await expect(store.put(roomId, 'att1', 'log', BYTES)).rejects.toBeInstanceOf(
        InvalidRoomAttachmentIdError
      );
      await expect(store.deleteRoom(roomId)).rejects.toBeInstanceOf(InvalidRoomAttachmentIdError);
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
