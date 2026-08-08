/**
 * The seam, asserted rather than promised.
 *
 * "Sync-ready" is only worth saying if something would break when it stopped
 * being true, so this file stands a store up that keeps nothing on this machine
 * — an absolute URL out of `put`, `null` out of `localPath` — and pins what the
 * rest of the system is then obliged to do with those two answers.
 *
 * Phase 1 can only assert the shape and the store's own answers. The route half
 * ("the cockpit serves that URL unchanged") arrives with the upload route, and
 * the projector half ("a null localPath takes the fetch branch") with the agent
 * projection; both land in this file, which is why it is written as a home for
 * three cases rather than as one.
 */
import { describe, it, expect } from 'vitest';
import type { RoomAttachmentStore } from '../room-attachment-store.js';

/**
 * A store that keeps nothing locally and answers with an absolute URL — exactly
 * what a bucket-backed implementation would do.
 */
const cdn: RoomAttachmentStore = {
  put: async () => ({ url: 'https://cdn.example/x.bin' }),
  get: async () => null,
  localPath: async () => null,
  deleteRoom: async () => {},
};

describe('the RoomAttachmentStore seam', () => {
  it('is satisfied by a store that never touches this machine', async () => {
    // The compiler is doing the real work here: `cdn` is annotated with the
    // interface, so a method the port grew and a remote store could not answer
    // would fail this file before it ran.
    await expect(cdn.deleteRoom('room1')).resolves.toBeUndefined();
  });

  it('answers put with the absolute URL it chose, untouched by any path logic', async () => {
    const { url } = await cdn.put('room1', 'att1', 'bin', Buffer.from('x'));

    expect(url).toBe('https://cdn.example/x.bin');
  });

  it('answers null from localPath, the honest signal that the bytes are not here', async () => {
    expect(await cdn.localPath('room1', 'att1', 'bin')).toBeNull();
  });
});
