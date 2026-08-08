/**
 * Reclaiming files that were uploaded and never posted.
 *
 * The sweep's whole risk is deleting the wrong thing, so the two negative cases
 * matter more than the positive one: a file somebody attached a minute ago is
 * still on its way into a message, and a file already ON a message is part of
 * what somebody said. Losing either would be far worse than keeping stale
 * bytes for another day, which is why both are asserted here and why
 * `deleteUnbound` re-checks the binding rather than trusting the list it was
 * handed.
 *
 * Over a real store and a real database, because the claim is that rows and
 * bytes go together.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { createTestDb } from '@dorkos/test-utils/db';
import { roomAttachments, and, eq, type Db } from '@dorkos/db';
import { AttachmentRowStore } from '../attachment-row-store.js';
import { LocalRoomAttachmentStore } from '../local-room-attachment-store.js';
import { sweepUnboundAttachments, UNBOUND_ATTACHMENT_TTL_MS } from '../unbound-sweep.js';

const ROOM_ID = 'room1';
const OTHER_ROOM = 'room2';
const NOW = Date.UTC(2026, 7, 8, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

describe('reclaiming unposted attachments', () => {
  let db: Db;
  let dorkHome: string;
  let rows: AttachmentRowStore;
  let store: LocalRoomAttachmentStore;

  beforeEach(async () => {
    db = createTestDb();
    dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-sweep-'));
    rows = new AttachmentRowStore(db);
    store = new LocalRoomAttachmentStore(dorkHome);
  });

  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
  });

  /** Stage one file — bytes and row — aged to `hoursOld`. */
  async function stage(
    id: string,
    hoursOld: number,
    opts: { roomId?: string; entryId?: string } = {}
  ): Promise<void> {
    const roomId = opts.roomId ?? ROOM_ID;
    await store.put(roomId, id, 'log', Buffer.from(`bytes of ${id}`));
    rows.create(
      {
        roomId,
        id,
        authorId: 'human',
        name: `${id}.log`,
        extension: 'log',
        mimeType: 'text/plain',
        size: 11,
        preview: null,
        url: `/api/rooms/${roomId}/attachments/${id}`,
      },
      new Date(NOW - hoursOld * HOUR).toISOString()
    );
    // Binding is the entry's own transaction in production; here the state is
    // what matters, not how it was reached. The parent entry is real because
    // the composite foreign key is real — it refused an invented id, which is
    // exactly what it is for.
    if (opts.entryId) {
      db.$client
        .prepare(
          `INSERT INTO room_entries
             (room_id, seq, id, author_id, kind, body, mentions, mention_spans,
              session_id, cascade_root, cascade_depth, parent_entry_id,
              thread_root_entry_id, signature, created_at)
           VALUES (?, 1, ?, 'human', 'post', '{"text":"here it is"}', '[]', '[]',
                   NULL, ?, 0, NULL, NULL, NULL, ?)`
        )
        .run(roomId, opts.entryId, opts.entryId, new Date(NOW).toISOString());
      db.update(roomAttachments)
        .set({ entryId: opts.entryId })
        .where(and(eq(roomAttachments.roomId, roomId), eq(roomAttachments.id, id)))
        .run();
    }
  }

  /** Whether the row is still there. */
  function rowExists(id: string, roomId = ROOM_ID): boolean {
    return rows.get(roomId, id) !== null;
  }

  /** Whether the bytes are still there. */
  async function bytesExist(id: string, roomId = ROOM_ID): Promise<boolean> {
    return (await store.localPath(roomId, id, 'log')) !== null;
  }

  /** Run the sweep at the pinned clock. */
  function sweep(roomId = ROOM_ID): Promise<number> {
    return sweepUnboundAttachments({ rows, store, roomId, now: () => NOW });
  }

  it('drops an unposted file older than the TTL, rows and bytes together', async () => {
    await stage('stale', 25);

    expect(await sweep()).toBe(1);

    expect(rowExists('stale')).toBe(false);
    expect(await bytesExist('stale')).toBe(false);
  });

  it('KEEPS an unposted file that is still fresh', async () => {
    // Somebody attached this twenty-three hours ago and has not sent it yet.
    // Their composer still shows the chip, and the serve route still hands them
    // the bytes; reclaiming it would empty a message being written.
    await stage('fresh', 23);

    expect(await sweep()).toBe(0);

    expect(rowExists('fresh')).toBe(true);
    expect(await bytesExist('fresh')).toBe(true);
  });

  it('KEEPS a posted file however old it is', async () => {
    // Bound to an entry, so it is part of what somebody said. Age is irrelevant:
    // a message must never lose the file it is about.
    await stage('posted', 300, { entryId: 'entry-1' });

    expect(await sweep()).toBe(0);

    expect(rowExists('posted')).toBe(true);
    expect(await bytesExist('posted')).toBe(true);
  });

  it('leaves another room’s stale files to that room’s own sweep', async () => {
    await stage('mine', 25);
    await stage('theirs', 25, { roomId: OTHER_ROOM });

    expect(await sweep()).toBe(1);

    expect(rowExists('mine')).toBe(false);
    expect(rowExists('theirs', OTHER_ROOM)).toBe(true);
    expect(await bytesExist('theirs', OTHER_ROOM)).toBe(true);
  });

  it('sweeps exactly at the boundary, and not a moment before', async () => {
    const ttlHours = UNBOUND_ATTACHMENT_TTL_MS / HOUR;
    await stage('justInside', ttlHours - 0.01);
    await stage('justOutside', ttlHours + 0.01);

    expect(await sweep()).toBe(1);

    expect(rowExists('justInside')).toBe(true);
    expect(rowExists('justOutside')).toBe(false);
  });

  it('is a no-op on a room that has staged nothing', async () => {
    expect(await sweep()).toBe(0);
  });

  it('never throws when the store cannot delete', async () => {
    await stage('stale', 25);
    const brokenStore = {
      ...store,
      delete: async () => {
        throw new Error('disk is on fire');
      },
    } as unknown as LocalRoomAttachmentStore;

    // Housekeeping must not fail the upload it is riding on.
    await expect(
      sweepUnboundAttachments({ rows, store: brokenStore, roomId: ROOM_ID, now: () => NOW })
    ).resolves.toBe(0);
  });

  it('keeps sweeping after one file it cannot delete', async () => {
    await stage('bad', 25);
    await stage('good', 25);
    let calls = 0;
    const flakyStore = {
      ...store,
      delete: async (roomId: string, id: string, extension: string) => {
        calls += 1;
        if (id === 'bad') throw new Error('disk is on fire');
        return store.delete(roomId, id, extension);
      },
    } as unknown as LocalRoomAttachmentStore;

    // One unreadable file must not strand the rest — that is how a staging area
    // grows forever behind a single bad row.
    const reclaimed = await sweepUnboundAttachments({
      rows,
      store: flakyStore,
      roomId: ROOM_ID,
      now: () => NOW,
    });

    expect(calls).toBe(2);
    expect(reclaimed).toBe(1);
    expect(await bytesExist('good')).toBe(false);
  });
});
