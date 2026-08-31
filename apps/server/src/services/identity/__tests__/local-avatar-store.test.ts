/**
 * The one implementation of {@link AvatarStore} that exists today: bytes on
 * this machine, under the DorkOS data directory.
 *
 * Two things here are load-bearing rather than incidental. The id is opaque and
 * arrives from a URL, so nothing it contains may reach the filesystem as a path
 * — `..` and `/` are refused rather than sanitized. And a photo is a REPLACEMENT
 * for whatever was there, across formats: uploading a PNG over a JPEG must leave
 * one file, not two, or the next read is a coin flip.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { logger } from '../../../lib/logger.js';
import { InvalidAvatarIdError } from '../avatar-store.js';
import { LocalAvatarStore } from '../local-avatar-store.js';

/**
 * Lets one `rename` fail on demand — the interruption that decides whether the
 * write order is safe. Everything else passes straight through to the real
 * filesystem, so these are still tests against real files.
 */
const fsControl = vi.hoisted(() => ({ failNextRename: false }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    default: actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (fsControl.failNextRename) {
        fsControl.failNextRename = false;
        throw Object.assign(new Error('simulated rename failure'), { code: 'EIO' });
      }
      return actual.rename(...args);
    },
  };
});

/** A real 1×1 PNG — the smallest thing that is genuinely the format. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 7)]);

async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('LocalAvatarStore', () => {
  let dorkHome: string;
  let store: LocalAvatarStore;

  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-avatars-'));
    store = new LocalAvatarStore(dorkHome);
  });

  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
  });

  it('writes the photo under <dorkHome>/avatars and hands back a URL for it', async () => {
    const { url } = await store.put('author-1', PNG, 'image/png');

    expect(await readdir(path.join(dorkHome, 'avatars'))).toEqual(['author-1.png']);
    expect(url).toMatch(/^\/api\/profile\/avatar\/author-1\?v=[0-9a-f]+$/);
  });

  it('changes the URL when the bytes change, so a replaced photo is not a stale cache hit', async () => {
    const first = await store.put('author-1', PNG, 'image/png');
    const second = await store.put('author-1', Buffer.concat([PNG, Buffer.from([0])]), 'image/png');

    expect(second.url).not.toBe(first.url);
  });

  it('reads the bytes back with the stored type and a strong ETag', async () => {
    await store.put('author-1', PNG, 'image/png');
    const stored = await store.get('author-1');

    expect(stored).not.toBeNull();
    expect(stored?.contentType).toBe('image/png');
    expect(stored?.etag).toMatch(/^"[0-9a-f]+"$/);
    expect(await drain(stored!.stream)).toEqual(PNG);
  });

  it('gives the same ETag the URL was versioned with', async () => {
    const { url } = await store.put('author-1', PNG, 'image/png');
    const stored = await store.get('author-1');

    expect(stored?.etag).toBe(`"${url.split('?v=')[1]}"`);
  });

  it('answers null for an identity with no photo', async () => {
    expect(await store.get('nobody')).toBeNull();
  });

  it('replaces across formats, leaving exactly one file', async () => {
    await store.put('author-1', JPEG, 'image/jpeg');
    await store.put('author-1', PNG, 'image/png');

    expect(await readdir(path.join(dorkHome, 'avatars'))).toEqual(['author-1.png']);
    const stored = await store.get('author-1');
    expect(stored?.contentType).toBe('image/png');
  });

  it('keeps the old photo when committing the new one fails', async () => {
    await store.put('author-1', JPEG, 'image/jpeg');
    fsControl.failNextRename = true;

    await expect(store.put('author-1', PNG, 'image/png')).rejects.toThrow(
      'simulated rename failure'
    );

    // The replacement never landed, so the person still has the photo they had.
    // Dropping the old format BEFORE committing the new one would have left them
    // with nothing here — which is the whole reason for the order.
    const stored = await store.get('author-1');
    expect(stored?.contentType).toBe('image/jpeg');
    expect(await drain(stored!.stream)).toEqual(JPEG);
  });

  it('leaves exactly one photo when two cross-format uploads race', async () => {
    // Repeated because a race that resolves correctly once may still be a race.
    // Unserialized, the interleaving where one upload's cleanup deletes the
    // other's committed file shows up within a handful of rounds.
    for (let round = 0; round < 25; round++) {
      const [, second] = await Promise.all([
        store.put('author-1', JPEG, 'image/jpeg'),
        store.put('author-1', PNG, 'image/png'),
      ]);

      // One file, and it is the one the LAST writer committed.
      expect(await readdir(path.join(dorkHome, 'avatars'))).toEqual(['author-1.png']);

      // And the URL that writer recorded names the bytes GET actually serves —
      // a hash pointing at a file nobody can fetch is the same bug wearing a
      // different face.
      const stored = await store.get('author-1');
      expect(stored?.etag).toBe(`"${second.url.split('?v=')[1]}"`);
      expect(await drain(stored!.stream)).toEqual(PNG);

      await store.delete('author-1');
    }
  });

  it('deletes the file, and deleting again is not an error', async () => {
    await store.put('author-1', PNG, 'image/png');
    await store.delete('author-1');
    await store.delete('author-1');

    expect(await store.get('author-1')).toBeNull();
    expect(await readdir(path.join(dorkHome, 'avatars'))).toEqual([]);
  });

  it.each(['../escape', 'a/b', '..', '', '.', 'a\0b'])(
    'refuses to write an id that is a path: %j',
    async (id) => {
      await expect(store.put(id, PNG, 'image/png')).rejects.toBeInstanceOf(InvalidAvatarIdError);
      await expect(store.delete(id)).rejects.toBeInstanceOf(InvalidAvatarIdError);
      expect(await store.get(id)).toBeNull();
    }
  );

  it('cannot be walked out of even when a file really is up there', async () => {
    const outside = path.join(dorkHome, 'secret.png');
    await writeFile(outside, PNG);
    await mkdir(path.join(dorkHome, 'avatars'), { recursive: true });

    expect(await store.get('../secret')).toBeNull();
    // And the file it was aiming at is untouched.
    expect(await readFile(outside)).toEqual(PNG);
  });

  describe('orphan .tmp sweep', () => {
    /** Back-date a file's mtime so the sweep reads it as old enough to reap. */
    async function backdate(file: string, ageMs: number): Promise<void> {
      const then = new Date(Date.now() - ageMs);
      await utimes(file, then, then);
    }

    it('reaps a staging file an interrupted put left behind long ago, on construction', async () => {
      const avatarsDir = path.join(dorkHome, 'avatars');
      await mkdir(avatarsDir, { recursive: true });
      const orphan = path.join(avatarsDir, 'author-1.png.dead-uuid.tmp');
      await writeFile(orphan, PNG);
      await backdate(orphan, 2 * 60 * 60 * 1000); // two hours — past ORPHAN_TMP_AGE_MS
      await writeFile(path.join(avatarsDir, 'author-1.png'), PNG);

      // The constructor's sweep is fire-and-forget: readdir + stat + rm across
      // a few microtask turns, so poll rather than assume one tick.
      new LocalAvatarStore(dorkHome);
      await vi.waitFor(async () => {
        expect(await readdir(avatarsDir)).toEqual(['author-1.png']);
      });
    });

    it('leaves a fresh .tmp file alone — it could be a write still in flight', async () => {
      // The race this guards: a second store instance (here, standing in for a
      // second process) must not delete the staging file an overlapping put()
      // has not yet renamed into place. A file this young cannot be an orphan —
      // put()'s own staging window is milliseconds — so the sweep must skip it.
      const avatarsDir = path.join(dorkHome, 'avatars');
      await mkdir(avatarsDir, { recursive: true });
      const inFlight = path.join(avatarsDir, 'author-1.png.live-uuid.tmp');
      await writeFile(inFlight, PNG);

      new LocalAvatarStore(dorkHome);
      // Give the detached sweep every chance to run before asserting the
      // negative — there is no "it never will" event to wait for instead.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await readdir(avatarsDir)).toEqual([path.basename(inFlight)]);
    });

    it('logs and swallows a sweep failure instead of throwing or crashing the process', async () => {
      // A real seam, not a tautology: `new LocalAvatarStore()` can never
      // synchronously throw regardless of what the detached sweep does (it is
      // `void`ed), so `expect(() => new LocalAvatarStore(...)).not.toThrow()`
      // passes even if the catch-and-log path were deleted outright. Forcing a
      // genuine failure — `avatars` exists as a FILE, so `readdir` rejects with
      // ENOTDIR rather than the expected-and-silent ENOENT — and asserting the
      // log line actually happens is a test that fails if that path regresses.
      await writeFile(path.join(dorkHome, 'avatars'), 'not a directory');
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);

      new LocalAvatarStore(dorkHome);

      await vi.waitFor(() => {
        expect(errorSpy).toHaveBeenCalledWith(
          '[LocalAvatarStore] orphan sweep could not list avatars dir',
          expect.anything()
        );
      });
      errorSpy.mockRestore();
    });
  });
});
